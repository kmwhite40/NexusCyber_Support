// Proof against real Postgres that the auto-close sweep makes the same close a person makes —
// closed_at stamped, resolved_at kept, a status_changed event attributed to the system — and
// that the closed ticket still reopens.
//
// The sweep runs across every org, so the clock is pinned in 2001: the cutoff then predates every
// row any other suite or the seed writes, and only this suite's backdated tickets are in reach.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket, transition } from '../../src/modules/tickets.js';
import { sweepAutoCloseResolved } from '../../src/jobs/auto-close-resolved.js';
import type { Principal } from '../../src/types.js';

const NOW = new Date('2001-01-09T00:00:00.000Z'); // cutoff at 7 days: 2001-01-02

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('auto-close of resolved tickets', () => {
  let agent: Principal;
  let orgId: string;
  const created: string[] = [];

  async function resolvedTicket(resolvedAt: string): Promise<string> {
    const t = await createTicket(agent, { subject: `auto-close ${Date.now()}`, organizationId: orgId });
    created.push(t.id);
    await transition(agent, t.id, 'assigned');
    await transition(agent, t.id, 'in_progress');
    await transition(agent, t.id, 'resolved', { resolutionCode: 'fixed' });
    await withSystemContext((sql) =>
      sql.query('UPDATE tickets SET resolved_at=$2 WHERE id=$1', [t.id, resolvedAt]));
    return t.id;
  }

  const row = (id: string) => withSystemContext(async (sql) =>
    (await sql.query('SELECT status, resolved_at, closed_at FROM tickets WHERE id=$1', [id])).rows[0]);

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  afterAll(async () => {
    if (created.length) {
      await withSystemContext((sql) => sql.query('DELETE FROM tickets WHERE id = ANY($1::uuid[])', [created]));
    }
  });

  it('closes a stale Resolved ticket as the system, keeps a fresh one, and is idempotent', async () => {
    const stale = await resolvedTicket('2001-01-01T00:00:00.000Z');
    const fresh = await resolvedTicket('2001-01-05T00:00:00.000Z');

    const out = await sweepAutoCloseResolved(NOW, 7);
    expect(out.closed).toBe(1);
    expect(out.failed).toBe(0);

    const closed = await row(stale);
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).not.toBeNull();
    // resolved -> closed is not a reopen: the resolution stamp is part of the record.
    expect(new Date(closed.resolved_at).toISOString()).toBe('2001-01-01T00:00:00.000Z');
    expect((await row(fresh)).status).toBe('resolved');

    const ev = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT actor_id, detail FROM ticket_events
          WHERE ticket_id=$1 AND event_type='status_changed' ORDER BY created_at DESC LIMIT 1`,
        [stale])).rows[0]);
    expect(ev.actor_id).toBeNull();
    expect(ev.detail).toEqual({ from: 'resolved', to: 'closed' });

    // A second run finds nothing left to do.
    expect((await sweepAutoCloseResolved(NOW, 7)).closed).toBe(0);

    // And closed is not a dead end.
    const reopened = await transition(agent, stale, 'reopened');
    expect(reopened.status).toBe('reopened');
  });
});

// Proof against real Postgres that a remediation ticket survives repeated close/reopen with its
// identity and conversation intact. Carbon's §6: "A reopen must preserve the ticket's identity
// and history, not fork it. Same ticketId, same ticketKey, same comment thread."
import { describe, it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket, transition, addComment } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('a remediation ticket reopens repeatedly, keeping its identity', () => {
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  it('survives two full close/reopen cycles with one id, one key and one thread', async () => {
    const created = await createTicket(agent, {
      subject: 'CVE-2026-1234 on the web tier',
      organizationId: orgId,
      externalRef: `reopen-${Date.now()}`,
      externalSource: 'poam',
    });

    await addComment(agent, created.id, 'Evidence collected: still failing.', 'internal');

    // Into active work once; each later round re-enters from `reopened`, which is the only
    // state a reopened ticket can leave to.
    await transition(agent, created.id, 'assigned');

    for (const round of [1, 2]) {
      await transition(agent, created.id, 'in_progress');
      await transition(agent, created.id, 'resolved', { resolutionCode: 'fixed' });
      const closed = await transition(agent, created.id, 'closed');
      expect(closed.status).toBe('closed');
      expect(closed.closed_at).not.toBeNull();

      const reopened = await transition(agent, created.id, 'reopened');
      expect([round, reopened.status]).toEqual([round, 'reopened']);
      // Identity is preserved — not a fork.
      expect(reopened.id).toBe(created.id);
      expect(reopened.ticket_number).toBe(created.ticket_number);
      // Leaving a terminal state clears the terminal stamps, so the row never reads as
      // simultaneously closed and open.
      expect(reopened.closed_at).toBeNull();
      expect(reopened.resolved_at).toBeNull();
    }

    // The conversation survived both cycles.
    const comments = await withSystemContext(async (sql) =>
      (await sql.query('SELECT count(*)::int AS n FROM ticket_comments WHERE ticket_id=$1', [created.id])).rows[0].n,
    );
    expect(comments).toBeGreaterThanOrEqual(1);

    // And so did the audit trail of every hop.
    const events = await withSystemContext(async (sql) =>
      (await sql.query(
        "SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id=$1 AND event_type='status_changed'",
        [created.id])).rows[0].n,
    );
    expect(events).toBe(9); // 1 assign + (in_progress, resolved, closed, reopened) x 2
  });
});

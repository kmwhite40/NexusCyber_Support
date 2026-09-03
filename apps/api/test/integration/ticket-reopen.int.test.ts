import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket, transition } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

// Reopening a ticket left `resolved_at` stamped from the earlier resolve, so the row read as
// resolved and open at the same time: an active status carrying a resolution timestamp.
//
// This is what was actually behind "I resolve tickets and they still sit there as if they're
// open" — resolved -> reopened -> in_progress is a legal route through the transition map, and
// nothing on the way back out cleared the terminal stamps. (The ingest path had the same defect
// and was fixed separately; it was not the path being used.)
async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const stamps = (id: string) => withSystemContext(async (sql) =>
  (await sql.query('SELECT status, resolved_at, closed_at FROM tickets WHERE id=$1', [id])).rows[0]);

describeDb('reopening a ticket clears the terminal stamps', () => {
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    orgId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
  });

  async function resolvedTicket() {
    const t = await createTicket(agent, {
      type: 'incident', subject: 'Reopen stamp check', organizationId: orgId, impact: 3, urgency: 3,
    });
    await transition(agent, t.id, 'assigned');
    await transition(agent, t.id, 'in_progress');
    await transition(agent, t.id, 'resolved', { resolutionCode: 'fixed' });
    return t.id;
  }

  it('stamps resolved_at on the way in', async () => {
    const id = await resolvedTicket();
    const row = await stamps(id);
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
  });

  it('clears resolved_at when the ticket is reopened', async () => {
    const id = await resolvedTicket();
    await transition(agent, id, 'reopened');
    const row = await stamps(id);
    expect(row.status).toBe('reopened');
    expect(row.resolved_at).toBeNull();
  });

  it('leaves it cleared once work restarts', async () => {
    const id = await resolvedTicket();
    await transition(agent, id, 'reopened');
    await transition(agent, id, 'in_progress');
    const row = await stamps(id);
    expect(row.status).toBe('in_progress');
    expect(row.resolved_at).toBeNull();
  });

  it('refuses to reopen a closed ticket at all — closed is terminal here', async () => {
    // Worth pinning rather than assuming: because this route does not exist, transition() never
    // needs to clear closed_at. The mail-ingest path DOES reopen closed tickets (an out-of-band
    // customer reply must not vanish), which is exactly why the stamp clearing lives there too.
    const id = await resolvedTicket();
    await transition(agent, id, 'closed');
    expect((await stamps(id)).closed_at).not.toBeNull();
    await expect(transition(agent, id, 'reopened')).rejects.toThrow(/illegal transition/i);
  });

  it('does not disturb the stamp on a transition between terminal states', async () => {
    // resolved -> closed is not a reopen; the resolution genuinely happened and its timestamp
    // is part of the record.
    const id = await resolvedTicket();
    const before = await stamps(id);
    await transition(agent, id, 'closed');
    const after = await stamps(id);
    expect(after.resolved_at).toEqual(before.resolved_at);
    expect(after.closed_at).not.toBeNull();
  });

  // Migration 0075 cleared the rows written before transition() started clearing these stamps.
  // This is the standing guard: a ticket that is not in a terminal status must not carry a terminal
  // timestamp, whatever path put it there. Analytics and SLA reporting both read resolved_at, so a
  // stamp on open work quietly skews resolution timing.
  it('leaves no ticket carrying a terminal timestamp it has moved past', async () => {
  const bad = await withSystemContext(async (sql) => (await sql.query(
    `SELECT ticket_number, status,
            resolved_at IS NOT NULL AS has_resolved_at,
            closed_at IS NOT NULL AS has_closed_at
       FROM tickets
      WHERE (status NOT IN ('resolved','closed') AND resolved_at IS NOT NULL)
         OR (status <> 'closed' AND closed_at IS NOT NULL)`,
  )).rows);
  expect(bad).toEqual([]);
  });
});

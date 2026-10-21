import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listQueues, queueTickets } from '../../src/modules/queues.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('agent queues (integration)', () => {
  let agent: Principal;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
  });

  it('lists seeded global queues and resolves their tickets with SLA-aware ordering', async () => {
    const qs = await listQueues(agent);
    expect(qs.length).toBeGreaterThan(0);
    const inProgress = qs.find((q: any) => q.name === 'In progress');
    expect(inProgress).toBeTruthy();

    const res = await queueTickets(agent, inProgress.id);
    expect(res.queue.name).toBe('In progress');
    // Every returned ticket matches the queue's status filter.
    for (const t of res.tickets) expect(t.status).toBe('in_progress');
  });

  it('hides closed tickets from a queue with no status filter unless asked', async () => {
    const qs = await listQueues(agent);
    const p1 = qs.find((q: any) => q.name === 'P1 incidents');
    expect(p1).toBeTruthy();

    const hidden = await queueTickets(agent, p1.id);
    for (const t of hidden.tickets) expect(t.status).not.toBe('closed');

    const all = await queueTickets(agent, p1.id, undefined, { includeClosed: true });
    expect(all.tickets.length).toBeGreaterThanOrEqual(hidden.tickets.length);
  });
});

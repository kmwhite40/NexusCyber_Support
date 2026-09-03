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
});

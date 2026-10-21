import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listTickets } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

// Tickets / My requests send exclude_status=closed; Archived sends status=closed. Read-only
// against seeded data so the suite leaves nothing behind.
describeDb('ticket list closed filter (integration)', () => {
  let agent: Principal;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
  });

  it('excludes closed tickets when asked and still returns them for status=closed', async () => {
    const all = await listTickets(agent, { limit: 200 });
    const open = await listTickets(agent, { limit: 200, excludeStatus: 'closed' });
    const closed = await listTickets(agent, { limit: 200, status: 'closed' });

    for (const t of open) expect(t.status).not.toBe('closed');
    for (const t of closed) expect(t.status).toBe('closed');
    expect(all.length).toBeGreaterThanOrEqual(open.length);
  });

  it('lets an explicit status win over the exclusion', async () => {
    const closed = await listTickets(agent, { limit: 200, status: 'closed' });
    const both = await listTickets(agent, { limit: 200, status: 'closed', excludeStatus: 'closed' });
    expect(both.map((t: any) => t.id)).toEqual(closed.map((t: any) => t.id));
  });
});

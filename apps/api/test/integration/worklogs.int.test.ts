import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { addWorklog, listForTicket } from '../../src/modules/worklogs.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('worklogs (integration)', () => {
  let agent: Principal;
  let ticketId: string;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    ticketId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM tickets WHERE ticket_number='DEMO-000001'")).rows[0].id,
    );
  });

  it('logs time and totals it with a human label', async () => {
    await addWorklog(agent, ticketId, 90, 'Investigated root cause');
    await addWorklog(agent, ticketId, 30, 'Applied fix');
    const res = await listForTicket(agent, ticketId);
    expect(res.total_minutes).toBeGreaterThanOrEqual(120);
    expect(res.entries.length).toBeGreaterThanOrEqual(2);
    expect(res.total_label).toMatch(/h/);
  });

  it('rejects non-positive minutes', async () => {
    await expect(addWorklog(agent, ticketId, 0)).rejects.toThrow(/positive/i);
  });
});

import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listCanned, render } from '../../src/modules/canned.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('canned responses (integration)', () => {
  let agent: Principal;
  let ticketId: string;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    ticketId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM tickets WHERE ticket_number='ACME-000001'")).rows[0].id,
    );
  });

  it('lists seeded global templates and renders placeholders from the ticket', async () => {
    const list = await listCanned(agent);
    expect(list.length).toBeGreaterThanOrEqual(4);
    const ack = list.find((c: any) => c.name === 'Resolved — please confirm');
    expect(ack).toBeTruthy();

    const out = await render(agent, ack.id, ticketId);
    expect(out.body).toContain('ACME-000001'); // {{ticket_number}} substituted
    expect(out.body).not.toContain('{{'); // no unrendered tokens for known keys
  });
});

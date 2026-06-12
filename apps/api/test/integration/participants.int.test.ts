import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { addParticipant, listForTicket, removeParticipant, processMentions } from '../../src/modules/participants.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('ticket participants + @mentions (integration)', () => {
  let agent: Principal;
  let ticketId: string;
  let acmeAdminId: string;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    const row = await withSystemContext(async (sql) => ({
      ticket: (await sql.query("SELECT id FROM tickets WHERE ticket_number='ACME-000001'")).rows[0].id,
      admin: (await sql.query("SELECT id FROM users WHERE email='admin@acme.example.com'")).rows[0].id,
    }));
    ticketId = row.ticket;
    acmeAdminId = row.admin;
  });

  it('adds, lists, and removes a participant', async () => {
    await addParticipant(agent, ticketId, acmeAdminId, 'collaborator');
    let list = await listForTicket(agent, ticketId);
    expect(list.find((p: any) => p.user_id === acmeAdminId)?.role).toBe('collaborator');
    await removeParticipant(agent, ticketId, acmeAdminId);
    list = await listForTicket(agent, ticketId);
    expect(list.find((p: any) => p.user_id === acmeAdminId)).toBeFalsy();
  });

  it('@mention adds the user as a watcher', async () => {
    const res = await processMentions(agent, ticketId, 'paging @admin@acme.example.com to take a look');
    expect(res.mentioned).toContain('admin@acme.example.com');
    const list = await listForTicket(agent, ticketId);
    expect(list.find((p: any) => p.user_id === acmeAdminId)?.role).toBe('watcher');
  });
});

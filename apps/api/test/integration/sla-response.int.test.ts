import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket } from '../../src/modules/tickets.js';
import { markResponseMet } from '../../src/modules/sla.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

const states = (ticketId: string) =>
  withSystemContext(async (sql) =>
    (await sql.query('SELECT metric, state FROM sla_instances WHERE ticket_id=$1', [ticketId])).rows as Array<{ metric: string; state: string }>,
  );

describeDb('SLA response-met on first response (integration)', () => {
  let endUser: Principal;
  beforeAll(async () => { endUser = await principalByEmail('user@demo.example.com'); });

  it('marks ONLY the response SLA met, leaving resolution running, and is idempotent', async () => {
    const t = await createTicket(endUser, { subject: `SLA response ${Date.now()}`, impact: 3, urgency: 3 });

    // Fresh ticket: both clocks running.
    const before = await states(t.id);
    expect(before.find((s) => s.metric === 'response')?.state).toBe('running');
    expect(before.find((s) => s.metric === 'resolution')?.state).toBe('running');

    const changed = await withSystemContext((sql) => markResponseMet(sql, t.id));
    expect(changed).toBe(true);

    const after = await states(t.id);
    expect(after.find((s) => s.metric === 'response')?.state).toBe('met');
    expect(after.find((s) => s.metric === 'resolution')?.state).toBe('running'); // resolution untouched

    // Idempotent: a second call changes nothing (already met).
    const again = await withSystemContext((sql) => markResponseMet(sql, t.id));
    expect(again).toBe(false);
  });
});

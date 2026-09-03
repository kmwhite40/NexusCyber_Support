import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createAlert, acknowledgeAlert, resolveAlert, escalateAlert, listAlerts } from '../../src/modules/alerts.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('alerts (integration)', () => {
  let manager: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('dedups open alerts on the same dedup_key', async () => {
    const key = `int-dedup-${Date.now()}`;
    const a1 = await createAlert(manager, { summary: 'first', dedupKey: key, organizationId: orgId });
    const a2 = await createAlert(manager, { summary: 'second', dedupKey: key, organizationId: orgId });
    expect(a2.id).toBe(a1.id);
  });

  it('enforces the state machine: ack then resolve; resolved is terminal', async () => {
    const a = await createAlert(manager, { summary: 'lifecycle', severity: 'P2', organizationId: orgId });
    const acked = await acknowledgeAlert(manager, a.id);
    expect(acked.state).toBe('acknowledged');
    const resolved = await resolveAlert(manager, a.id);
    expect(resolved.state).toBe('resolved');
    await expect(acknowledgeAlert(manager, a.id)).rejects.toThrow(); // resolved -> acknowledged not allowed
  });

  it('escalation opens a ticket and a page and stores back-references', async () => {
    const a = await createAlert(manager, { summary: 'escalate me', severity: 'P1', organizationId: orgId });
    const res = await escalateAlert(manager, a.id, { toTicket: true, toPage: true });
    expect(res.escalated_ticket_id).toBeTruthy();
    expect(res.escalated_page_id).toBeTruthy();
    // idempotent: second escalate keeps the same refs
    const again = await escalateAlert(manager, a.id, { toTicket: true, toPage: true });
    expect(again.escalated_ticket_id).toBe(res.escalated_ticket_id);
    expect(again.escalated_page_id).toBe(res.escalated_page_id);
  });
});

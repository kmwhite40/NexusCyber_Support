import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket, transition, pauseSla, resumeSla, getTicket } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

function slaStates(t: any): Record<string, string> {
  return Object.fromEntries((t.slas ?? []).map((s: any) => [s.metric, s.state]));
}

describeDb('SLA pause/resume (integration)', () => {
  let agent: Principal;
  let acmeId: string;

  beforeAll(async () => {
    agent = await principalByEmail('agent@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Acme'")).rows[0].id);
  });

  it('on-hold transition pauses running SLAs; resuming work resumes them', async () => {
    const created = await createTicket(agent, { subject: 'SLA pause test ticket', organizationId: acmeId, impact: 2, urgency: 2 });
    // Move to in_progress, then put on hold (waiting on customer) -> SLAs pause.
    await transition(agent, created.id, 'assigned');
    await transition(agent, created.id, 'in_progress');
    await transition(agent, created.id, 'waiting_customer');
    let full = await getTicket(agent, created.id);
    const paused = slaStates(full);
    expect(Object.values(paused)).toContain('paused');

    // Resume work -> SLAs run again.
    await transition(agent, created.id, 'in_progress');
    full = await getTicket(agent, created.id);
    const resumed = slaStates(full);
    expect(Object.values(resumed)).not.toContain('paused');
  });

  it('manual pause/resume toggles SLA state', async () => {
    const created = await createTicket(agent, { subject: 'Manual SLA pause', organizationId: acmeId, impact: 3, urgency: 3 });
    const p = await pauseSla(agent, created.id);
    expect(p.paused).toBeGreaterThanOrEqual(1);
    const r = await resumeSla(agent, created.id);
    expect(r.resumed).toBe(p.paused);
  });
});

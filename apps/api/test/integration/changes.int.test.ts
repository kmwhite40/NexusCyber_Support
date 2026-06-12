import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createChange, submitForCab, cabDecision, scheduleChange, transitionChange, getChange } from '../../src/modules/changes.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('change management + CAB (integration)', () => {
  let manager: Principal; // change.create + change.approve + change.implement
  let analyst: Principal; // change.approve (second CAB member)
  let acmeId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    analyst = await principalByEmail('analyst@nexus.example.com');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
  });

  it('standard changes are pre-approved without CAB', async () => {
    const c = await createChange(manager, { title: 'Rotate TLS cert', changeType: 'standard', organizationId: acmeId });
    const res = await submitForCab(manager, c.id, []);
    expect(res).toMatchObject({ status: 'approved', cab: false });
  });

  it('normal change runs full CAB, schedules, and completes', async () => {
    const c = await createChange(manager, { title: 'Upgrade mail connector', changeType: 'normal', organizationId: acmeId });
    const sub = await submitForCab(manager, c.id, [manager.id, analyst.id]);
    expect(sub).toMatchObject({ status: 'cab_review', steps: 2 });

    // First CAB member approves -> still in review (one step remaining).
    const d1 = await cabDecision(manager, c.id, true);
    expect(d1.status).toBe('cab_review');
    // Second CAB member approves -> change approved.
    const d2 = await cabDecision(analyst, c.id, true);
    expect(d2.status).toBe('approved');

    const sched = await scheduleChange(manager, c.id, '2026-08-01T02:00:00.000Z', '2026-08-01T04:00:00.000Z');
    expect(sched.status).toBe('scheduled');

    await transitionChange(manager, c.id, 'implementing');
    await transitionChange(manager, c.id, 'review');
    const done = await transitionChange(manager, c.id, 'closed');
    expect(done.status).toBe('closed');

    const full = await getChange(manager, c.id);
    expect(full.cab_steps.length).toBe(2);
  });

  it('a CAB rejection rejects the change', async () => {
    const c = await createChange(manager, { title: 'Risky firewall change', changeType: 'emergency', organizationId: acmeId });
    await submitForCab(manager, c.id, [analyst.id]);
    const res = await cabDecision(analyst, c.id, false, 'insufficient backout plan');
    expect(res.status).toBe('rejected');
  });
});

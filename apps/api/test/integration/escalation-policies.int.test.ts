import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createPolicy, listPolicies, deletePolicy, resolveStepTarget } from '../../src/modules/escalation-policies.js';
import { Errors } from '../../src/errors.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('escalation policies (integration)', () => {
  let manager: Principal;
  let endUser: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    endUser = await principalByEmail('user@demo.example.com');
    orgId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  it('manager creates a policy with two steps → list returns it with normalized order', async () => {
    const pol = await createPolicy(manager, {
      name: 'Test: P1 alert policy',
      organizationId: orgId,
      steps: [
        { targetType: 'user', targetId: manager.id, delayMinutes: 10 },
        { targetType: 'user', targetId: manager.id, delayMinutes: 0 },
      ],
    });
    expect(pol.name).toBe('Test: P1 alert policy');
    expect(pol.steps).toHaveLength(2);
    // Normalized: sorted by delay, 1-based order
    expect(pol.steps[0].order).toBe(1);
    expect(pol.steps[0].delayMinutes).toBe(0);
    expect(pol.steps[1].order).toBe(2);
    expect(pol.steps[1].delayMinutes).toBe(10);

    const policies = await listPolicies(manager);
    expect(policies.find((p: any) => p.id === pol.id)).toBeTruthy();

    // Clean up
    await deletePolicy(manager, pol.id);
  });

  it('create with empty steps rejects with bad_request', async () => {
    await expect(
      createPolicy(manager, { name: 'Empty', organizationId: orgId, steps: [] }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('EndUser (no escalation.manage) is denied create', async () => {
    await expect(
      createPolicy(endUser, {
        name: 'Should fail',
        organizationId: orgId,
        steps: [{ targetType: 'user', targetId: endUser.id, delayMinutes: 0 }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('resolveStepTarget for a user step returns that user', async () => {
    const pol = await createPolicy(manager, {
      name: 'Test: resolve user step',
      organizationId: orgId,
      steps: [{ targetType: 'user', targetId: manager.id, delayMinutes: 0 }],
    });
    const result = await resolveStepTarget(manager, pol.id, 1);
    expect(result.targetType).toBe('user');
    expect(result.responder).toBeTruthy();
    expect((result.responder as any).id).toBe(manager.id);

    // Clean up
    await deletePolicy(manager, pol.id);
  });
});

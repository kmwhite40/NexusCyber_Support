// The Platform Users org-scope guards (modules/platform-users.ts), without a database.
//
// A delegated admin may only grant within their own scope. A ServiceDeskManager scoped to ALL
// organizations has allOrgs=true and assignedOrgs=[] (auth/principal.ts) — and the guard read
// only assignedOrgs, so every org was "outside your own scope" and they could grant nothing.
// What stays SuperAdmin-only is unchanged: the all-orgs grant itself, the SuperAdmin role, and
// managing a SuperAdmin or an all-orgs user.
import { describe, it, expect } from 'vitest';
import { assertScopeAllowed, assertCanManageTarget } from '../src/modules/platform-users.js';
import type { Principal } from '../src/types.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    id: 'actor', plane: 'nexus', email: 'x@pu-test.invalid', displayName: null, organizationId: null,
    roles: ['ServiceDeskManager'], permissions: ['admin.users.manage'], assignedOrgs: [], allOrgs: false, elevated: false,
    ...over,
  };
}

const allOrgsManager = principal({ allOrgs: true, assignedOrgs: [] });
const orgAManager = principal({ assignedOrgs: [ORG_A] });
const superAdmin = principal({ roles: ['SuperAdmin'], permissions: ['admin.users.manage', 'admin.superuser'], allOrgs: true });

describe('assertScopeAllowed', () => {
  it('lets an all-organizations admin grant per-org scope in any org', () => {
    expect(() => assertScopeAllowed(allOrgsManager, [ORG_A, ORG_B])).not.toThrow();
  });

  it('keeps a per-org admin inside their own orgs', () => {
    expect(() => assertScopeAllowed(orgAManager, [ORG_A])).not.toThrow();
    expect(() => assertScopeAllowed(orgAManager, [ORG_A, ORG_B])).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('refuses an admin with no scope at all', () => {
    expect(() => assertScopeAllowed(principal(), [ORG_A])).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('assertCanManageTarget', () => {
  const tier1InA = { id: 't', status: 'active', roles: ['Tier1'], scope: { mode: 'orgs' as const, orgIds: [ORG_A] } };

  it('lets an all-organizations admin manage a per-org user in any org', () => {
    expect(() => assertCanManageTarget(allOrgsManager, tier1InA)).not.toThrow();
    expect(() => assertCanManageTarget(allOrgsManager, { ...tier1InA, scope: { mode: 'orgs', orgIds: [ORG_B] } })).not.toThrow();
  });

  it('still keeps an all-organizations admin off SuperAdmins and all-organizations users', () => {
    expect(() => assertCanManageTarget(allOrgsManager, { ...tier1InA, roles: ['SuperAdmin'] }))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertCanManageTarget(allOrgsManager, { ...tier1InA, scope: { mode: 'all' } }))
      .toThrow(expect.objectContaining({ status: 403 }));
  });

  it('keeps a per-org admin off a user in another org', () => {
    expect(() => assertCanManageTarget(orgAManager, { ...tier1InA, scope: { mode: 'orgs', orgIds: [ORG_B] } }))
      .toThrow(expect.objectContaining({ status: 403 }));
  });

  it('lets a SuperAdmin manage anyone', () => {
    expect(() => assertCanManageTarget(superAdmin, { ...tier1InA, roles: ['SuperAdmin'], scope: { mode: 'all' } })).not.toThrow();
  });
});

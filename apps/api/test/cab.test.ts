import { describe, it, expect } from 'vitest';
import {
  resolveWriteScope, resolveReadScope, holdsGlobalCabGrant, raisesChanges, type CabScopeActor,
} from '../src/modules/cab.js';

// A per-customer or single-org platform admin: holds cab.manage, but NOT the platform-wide
// cab.manage.global. Global (organization_id IS NULL) CAB rows are inherited by every
// organization, and 0052's RLS policy makes them visible from every org context, so the
// app layer is the only thing standing between this actor and every tenant's defaults.
const scopedNexus: CabScopeActor = { plane: 'nexus', organizationId: null, canManageGlobal: false };
const platform: CabScopeActor = { plane: 'nexus', organizationId: null, canManageGlobal: true };
const customer: CabScopeActor = { plane: 'customer', organizationId: 'org-a', canManageGlobal: false };

describe('resolveWriteScope — global CAB rows are not everyone\'s to write', () => {
  it('refuses a single-org cab.manage holder who names no org (which would target GLOBAL)', () => {
    const d = resolveWriteScope(scopedNexus, undefined);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toContain('cab.manage.global');
  });

  it('refuses a single-org cab.manage holder explicitly targeting the global scope', () => {
    // This is the delete path: the row's own organization_id is null.
    expect(resolveWriteScope(scopedNexus, null).ok).toBe(false);
  });

  it('refuses a customer admin reaching for the global scope', () => {
    expect(resolveWriteScope(customer, null).ok).toBe(false);
  });

  it('allows the platform-wide grant to write the global scope', () => {
    expect(resolveWriteScope(platform, null)).toEqual({ ok: true, organizationId: null });
    expect(resolveWriteScope(platform, undefined)).toEqual({ ok: true, organizationId: null });
  });

  it('still lets a scoped admin write a named org (the PDP then checks assignment)', () => {
    expect(resolveWriteScope(scopedNexus, 'org-b')).toEqual({ ok: true, organizationId: 'org-b' });
  });

  it('pins a customer admin to their own org', () => {
    expect(resolveWriteScope(customer, undefined)).toEqual({ ok: true, organizationId: 'org-a' });
    expect(resolveWriteScope(customer, 'org-a')).toEqual({ ok: true, organizationId: 'org-a' });
    expect(resolveWriteScope(customer, 'org-b').ok).toBe(false);
  });

  it('refuses a customer principal with no organization', () => {
    expect(resolveWriteScope({ plane: 'customer', organizationId: null, canManageGlobal: false }).ok).toBe(false);
  });
});

describe('resolveReadScope', () => {
  it('does not gate reads on the global grant — global rows are meant to be inherited', () => {
    expect(resolveReadScope(scopedNexus, undefined)).toEqual({ ok: true, organizationId: null });
    expect(resolveReadScope(scopedNexus, 'org-b')).toEqual({ ok: true, organizationId: 'org-b' });
  });
  it('still pins a customer reader to their own org', () => {
    expect(resolveReadScope(customer, undefined)).toEqual({ ok: true, organizationId: 'org-a' });
    expect(resolveReadScope(customer, 'org-b').ok).toBe(false);
  });
});

// `scopeActor` used to compute this as a bare `can(actor,'cab.manage.global')` with NO
// resource context, so pdp.ts's inOrgScope short-circuited and the answer was pure RBAC.
// That was safe only while 0059 granted the permission exclusively to admin.superuser —
// and 0059's own comment invites granting it to non-superuser platform admins.
describe('holdsGlobalCabGrant — the platform grant needs platform scope', () => {
  it('refuses a single-org role assignment carrying cab.manage.global', () => {
    expect(holdsGlobalCabGrant({ permissions: ['cab.manage', 'cab.manage.global'], allOrgs: false })).toBe(false);
  });
  it('accepts the same grant on an all-orgs assignment', () => {
    expect(holdsGlobalCabGrant({ permissions: ['cab.manage', 'cab.manage.global'], allOrgs: true })).toBe(true);
  });
  it('accepts the platform superuser wildcard', () => {
    expect(holdsGlobalCabGrant({ permissions: ['admin.superuser'], allOrgs: true })).toBe(true);
  });
  it('refuses someone holding neither', () => {
    expect(holdsGlobalCabGrant({ permissions: ['cab.manage'], allOrgs: true })).toBe(false);
  });
});

describe('raisesChanges — segregation of duties backstop', () => {
  it('flags a principal that can raise changes', () => {
    expect(raisesChanges({ permissions: ['cab.manage', 'change.create'] })).toBe(true);
  });
  it('clears a CAB administrator who cannot raise changes', () => {
    expect(raisesChanges({ permissions: ['cab.manage', 'change.vote', 'change.implement'] })).toBe(false);
  });
  it('exempts the superuser wildcard rather than matching it', () => {
    // can() would resolve change.create for a superuser and lock break-glass admins out of
    // CAB configuration entirely; the literal list does not.
    expect(raisesChanges({ permissions: ['admin.superuser'] })).toBe(false);
  });
});

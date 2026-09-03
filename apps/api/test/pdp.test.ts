import { describe, it, expect } from 'vitest';
import { decide, can } from '../src/authz/pdp.js';
import type { Principal } from '../src/types.js';

function customer(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'u1',
    plane: 'customer',
    email: 'u@acme.com',
    displayName: null,
    organizationId: 'org-acme',
    roles: ['EndUser'],
    permissions: ['ticket.read.own', 'ticket.create'],
    assignedOrgs: [],
    allOrgs: false,
    elevated: false,
    ...overrides,
  };
}
function agent(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'a1',
    plane: 'nexus',
    email: 'a@nexus.com',
    displayName: null,
    organizationId: null,
    roles: ['Tier2'],
    permissions: ['ticket.read.all_assigned_customers', 'ticket.update'],
    assignedOrgs: ['org-acme', 'org-globex'],
    allOrgs: false,
    elevated: false,
    ...overrides,
  };
}

describe('PDP — RBAC + ABAC (deny-by-default)', () => {
  it('customer end user can read their own ticket in their org', () => {
    expect(can(customer(), 'ticket.read.own', { organizationId: 'org-acme', requesterId: 'u1' })).toBe(true);
  });

  it('customer cannot read a ticket in another org (out of scope)', () => {
    expect(can(customer(), 'ticket.read.own', { organizationId: 'org-other', requesterId: 'u1' })).toBe(false);
  });

  it("customer read.own is denied for another user's ticket (IDOR)", () => {
    const d = decide(customer(), 'ticket.read.own', { organizationId: 'org-acme', requesterId: 'someone-else' });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/requester/);
  });

  it('customer plane is denied internal-visibility resources', () => {
    expect(
      can(customer({ permissions: ['ticket.read.organization'], roles: ['OrgAdmin'] }), 'ticket.read.organization', {
        organizationId: 'org-acme',
        visibility: 'internal',
      }),
    ).toBe(false);
  });

  it('missing the verb is denied even within scope', () => {
    expect(can(customer({ permissions: [] }), 'ticket.update', { organizationId: 'org-acme' })).toBe(false);
  });

  it('agent sees assigned orgs but not unassigned ones', () => {
    expect(can(agent(), 'ticket.read.all_assigned_customers', { organizationId: 'org-acme' })).toBe(true);
    expect(can(agent(), 'ticket.read.all_assigned_customers', { organizationId: 'org-zzz' })).toBe(false);
  });

  it('admin.superuser bypasses RBAC and is cross-org (platform admin)', () => {
    // A platform SuperAdmin (admin.superuser) is a true cross-tenant operator: it holds
    // every verb AND every org scope. RLS mirrors this via the app.superuser GUC (0031).
    const su = agent({ permissions: ['admin.superuser'], assignedOrgs: [] });
    expect(can(su, 'anything.at.all', { organizationId: 'org-acme' })).toBe(true);
    expect(can(su, 'anything.at.all', { organizationId: 'org-zzz' })).toBe(true); // any org
  });

  it('a non-superuser nexus agent is still confined to assigned orgs', () => {
    expect(can(agent(), 'ticket.read.all_assigned_customers', { organizationId: 'org-acme' })).toBe(true);
    expect(can(agent(), 'ticket.read.all_assigned_customers', { organizationId: 'org-zzz' })).toBe(false);
  });

  it('an all-orgs grant (org-NULL assignment) scopes to every org without superuser', () => {
    // Delegated admin: all-orgs visibility but role-limited verbs (NOT admin.superuser).
    const all = agent({ allOrgs: true, assignedOrgs: [] });
    expect(can(all, 'ticket.read.all_assigned_customers', { organizationId: 'org-acme' })).toBe(true);
    expect(can(all, 'ticket.read.all_assigned_customers', { organizationId: 'org-zzz' })).toBe(true);
    // Still bounded by RBAC — it does not hold verbs outside its role.
    expect(can(all, 'admin.users.manage', { organizationId: 'org-acme' })).toBe(false);
  });

  it('security-tagged resources require a security-capable role', () => {
    const t1 = agent({ roles: ['Tier1'], permissions: ['ticket.read.all_assigned_customers'] });
    expect(can(t1, 'ticket.read.all_assigned_customers', { organizationId: 'org-acme', securityTagged: true })).toBe(false);
    const sec = agent({ roles: ['SecurityAnalyst'], permissions: ['ticket.read.all_assigned_customers'] });
    expect(can(sec, 'ticket.read.all_assigned_customers', { organizationId: 'org-acme', securityTagged: true })).toBe(true);
  });
});

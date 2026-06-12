import { describe, it, expect } from 'vitest';
import { resolveSearchOrg } from '../src/modules/accounts.js';
import type { Principal } from '../src/types.js';

const customer = (over: Partial<Principal> = {}): Principal => ({
  id: 'u1', plane: 'customer', email: 'u@acme', displayName: null, organizationId: 'org-acme',
  roles: ['EndUser'], permissions: ['ticket.create'], assignedOrgs: [], elevated: false, ...over,
});
const agent = (over: Partial<Principal> = {}): Principal => ({
  id: 'a1', plane: 'nexus', email: 'a@nexus', displayName: null, organizationId: null,
  roles: ['Tier2'], permissions: ['ticket.create'], assignedOrgs: ['org-acme'], elevated: false, ...over,
});

describe('resolveSearchOrg', () => {
  it('forces a customer to their own org regardless of requested org', () => {
    expect(resolveSearchOrg(customer(), 'org-other')).toBe('org-acme');
  });
  it('uses the requested org for a nexus agent', () => {
    expect(resolveSearchOrg(agent(), 'org-acme')).toBe('org-acme');
  });
  it('returns null for a nexus agent with no org specified', () => {
    expect(resolveSearchOrg(agent(), undefined)).toBeNull();
  });
});

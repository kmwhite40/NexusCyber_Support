// Policy Decision Point — combines RBAC (role grants verbs) with ABAC (scope/conditions).
// Deny-by-default. See docs/nexus/01 §C.4.
//
//   Effective = Role grants (verbs) ∩ ABAC (scope + conditions) ∩ elevation state
//
import type { Principal } from '../types.js';
import { Errors } from '../errors.js';

export interface ResourceContext {
  organizationId?: string | null;
  requesterId?: string | null;
  visibility?: 'customer' | 'internal';
  securityTagged?: boolean;
}

export interface Decision {
  allow: boolean;
  reason: string;
}

/** Does the principal hold the permission verb at all (RBAC)? */
function hasVerb(principal: Principal, verb: string): boolean {
  if (principal.permissions.includes('admin.superuser')) return true;
  return principal.permissions.includes(verb);
}

/** Is the principal allowed to touch a resource in this org (ABAC scope)? */
function inOrgScope(principal: Principal, orgId?: string | null): boolean {
  if (!orgId) return true; // org-agnostic resource
  if (principal.permissions.includes('admin.superuser')) return true; // platform superuser: all orgs
  if (principal.plane === 'customer') return principal.organizationId === orgId;
  // nexus plane: must be an assigned customer
  return principal.assignedOrgs.includes(orgId);
}

export function decide(
  principal: Principal,
  verb: string,
  resource: ResourceContext = {},
): Decision {
  if (!hasVerb(principal, verb)) {
    return { allow: false, reason: `missing permission ${verb}` };
  }
  if (!inOrgScope(principal, resource.organizationId)) {
    return { allow: false, reason: 'out of organization scope' };
  }

  // Customer end users with only *.own may only see their own records.
  if (
    principal.plane === 'customer' &&
    verb === 'ticket.read.own' &&
    resource.requesterId &&
    resource.requesterId !== principal.id
  ) {
    return { allow: false, reason: 'not the requester (read.own)' };
  }

  // Internal notes are never visible to the customer plane.
  if (principal.plane === 'customer' && resource.visibility === 'internal') {
    return { allow: false, reason: 'internal visibility not permitted for customer plane' };
  }

  // Security-tagged tickets restricted to security-capable roles.
  if (resource.securityTagged) {
    const securityRoles = [
      'SecurityAnalyst',
      'Tier2',
      'Tier3',
      'IncidentCommander',
      'SecurityContact',
      'OrgAdmin',
      'Auditor',
    ];
    if (!principal.roles.some((r) => securityRoles.includes(r))) {
      return { allow: false, reason: 'security-tagged resource requires a security role' };
    }
  }

  return { allow: true, reason: 'permit' };
}

/** Throwing guard for route handlers. */
export function authorize(
  principal: Principal,
  verb: string,
  resource: ResourceContext = {},
): void {
  const d = decide(principal, verb, resource);
  if (!d.allow) throw Errors.forbidden(d.reason);
}

export function can(principal: Principal, verb: string, resource: ResourceContext = {}): boolean {
  return decide(principal, verb, resource).allow;
}

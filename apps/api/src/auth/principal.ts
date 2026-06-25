// Resolve a full Principal (roles, permissions, scope) from session claims.
import { withSystemContext } from '../db/pool.js';
import { activeGrantsFor, mergeGrantedPermissions } from '../modules/elevation.js';
import type { Principal, SessionClaims } from '../types.js';
import type { OrgContext } from '../db/pool.js';

export async function loadPrincipal(claims: SessionClaims): Promise<Principal> {
  return withSystemContext(async (sql) => {
    // Roles + permissions for this user (scoped role assignments + role->permission map).
    const { rows: roleRows } = await sql.query(
      `SELECT r.key AS role_key, ra.organization_id
         FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id
        WHERE ra.user_id = $1
          AND (ra.expires_at IS NULL OR ra.expires_at > now())`,
      [claims.sub],
    );

    const roleKeys = [...new Set(roleRows.map((r) => r.role_key as string))];
    const assignedOrgs = [
      ...new Set(roleRows.map((r) => r.organization_id).filter((x): x is string => !!x)),
    ];
    // A nexus role assignment with a NULL organization_id is an "all organizations" grant.
    const allOrgs =
      claims.plane === 'nexus' && roleRows.some((r) => r.organization_id == null);

    let permissions: string[] = [];
    if (roleKeys.length) {
      const { rows: permRows } = await sql.query(
        `SELECT DISTINCT rp.permission_key
           FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
          WHERE r.key = ANY($1)`,
        [roleKeys],
      );
      permissions = permRows.map((p) => p.permission_key as string);
    }

    // JIT elevation: union any active, non-expired grants into the effective permissions.
    // Reuse this system connection — nesting a second withSystemContext here
    // deadlocks the bounded admin pool under concurrent requests.
    const grants = await activeGrantsFor(claims.sub, sql);
    const elevated = grants.length > 0;
    permissions = mergeGrantedPermissions(permissions, grants);

    return {
      id: claims.sub,
      plane: claims.plane,
      email: claims.email,
      displayName: null,
      organizationId: claims.org,
      roles: roleKeys,
      permissions,
      assignedOrgs,
      allOrgs,
      elevated,
    };
  });
}

/** Build the DB org context that drives RLS for this principal. */
export function orgContextFor(principal: Principal): OrgContext {
  return {
    plane: principal.plane,
    orgId: principal.plane === 'customer' ? principal.organizationId : null,
    assignedOrgs: principal.plane === 'nexus' ? principal.assignedOrgs : [],
    allOrgs: principal.plane === 'nexus' && principal.allOrgs,
    elevated: principal.elevated,
    // A platform superuser is cross-org at the DB layer too (matches the PDP rule).
    superuser: principal.permissions.includes('admin.superuser'),
  };
}

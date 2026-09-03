// Platform User Administration (Phase 1).
//
// Administer NEXUS (platform/staff) user accounts and their organization scope. A nexus
// user's org scope is expressed entirely via role_assignments:
//   - per-org rows  (organization_id = <org>)  -> "specific organizations"
//   - one org-NULL row                           -> "all organizations" (allOrgs grant)
//
// Guardrails (the recommended defaults):
//   - Only a platform SuperAdmin may grant ALL-orgs scope or assign the SuperAdmin role
//     (prevents a delegated admin from escalating privilege).
//   - A delegated admin (admin.users.manage, not SuperAdmin) may only manage users and
//     grant scope WITHIN their own assigned orgs.
// All mutations are audit-logged.
import { withSystemContext } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';
import type { Sql } from '../db/pool.js';

// Nexus roles an admin may assign from the UI. SuperAdmin is intentionally gated (below).
const ASSIGNABLE_NEXUS_ROLES = [
  'Tier1',
  'Tier2',
  'SecurityAnalyst',
  'ServiceDeskManager',
  'SuperAdmin',
] as const;

export type ScopeInput = { mode: 'all' } | { mode: 'orgs'; orgIds: string[] };

export interface PlatformUser {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  has_password: boolean;
  roles: string[];
  all_orgs: boolean;
  org_ids: string[];
  created_at: string;
}

function isSuperAdmin(actor: Principal): boolean {
  return actor.permissions.includes('admin.superuser');
}

/** A delegated admin may only act within their own org scope. */
function assertScopeAllowed(actor: Principal, orgIds: string[]): void {
  if (isSuperAdmin(actor)) return;
  const outside = orgIds.filter((o) => !actor.assignedOrgs.includes(o));
  if (outside.length) {
    throw Errors.forbidden('cannot manage organizations outside your own scope');
  }
}

async function roleIdByKey(sql: Sql, key: string): Promise<string> {
  const { rows } = await sql.query(`SELECT id FROM roles WHERE key = $1 AND plane = 'nexus'`, [key]);
  if (!rows[0]) throw Errors.badRequest(`unknown nexus role ${key}`);
  return rows[0].id as string;
}

/** List the nexus roles that can be assigned from the Platform Users UI. */
export function assignableRoles(actor: Principal): string[] {
  // Only a SuperAdmin can grant the SuperAdmin role.
  return ASSIGNABLE_NEXUS_ROLES.filter((r) => r !== 'SuperAdmin' || isSuperAdmin(actor));
}

export async function listPlatformUsers(): Promise<PlatformUser[]> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT u.id, u.email, u.display_name, u.status, u.created_at,
              (u.password_hash IS NOT NULL) AS has_password,
              COALESCE(array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
              bool_or(ra.organization_id IS NULL AND ra.role_id IS NOT NULL) AS all_orgs,
              COALESCE(array_agg(DISTINCT ra.organization_id) FILTER (WHERE ra.organization_id IS NOT NULL), '{}') AS org_ids
         FROM users u
         LEFT JOIN role_assignments ra ON ra.user_id = u.id
         LEFT JOIN roles r ON r.id = ra.role_id
        WHERE u.plane = 'nexus'
        GROUP BY u.id
        ORDER BY u.display_name NULLS LAST, u.email`,
    );
    return rows as PlatformUser[];
  });
}

export async function createPlatformUser(
  actor: Principal,
  input: { email: string; displayName?: string; roleKeys?: string[]; password?: string; scope?: ScopeInput },
): Promise<{ id: string }> {
  const email = input.email.trim().toLowerCase();
  const roleKeys = [...new Set(input.roleKeys ?? [])];
  if (roleKeys.includes('SuperAdmin') && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant the SuperAdmin role');
  }
  const scope: ScopeInput = input.scope ?? { mode: 'orgs', orgIds: [] };
  if (scope.mode === 'all' && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant all-organizations scope');
  }
  if (scope.mode === 'orgs') assertScopeAllowed(actor, scope.orgIds);

  return withSystemContext(async (sql) => {
    const dup = await sql.query(`SELECT 1 FROM users WHERE plane='nexus' AND email=$1`, [email]);
    if (dup.rows.length) throw Errors.conflict('a platform user with this email already exists');

    const pw = input.password ? await hashPassword(input.password) : null;
    const ins = await sql.query(
      `INSERT INTO users (plane, organization_id, email, display_name, password_hash)
       VALUES ('nexus', NULL, $1, $2, $3) RETURNING id`,
      [email, input.displayName ?? email, pw],
    );
    const userId = ins.rows[0].id as string;
    await applyRoles(sql, userId, roleKeys.length ? roleKeys : ['Tier1']);
    await applyScope(sql, userId, roleKeys.length ? roleKeys : ['Tier1'], scope);
    await audit(actor, {
      action: 'admin.users.manage',
      resourceType: 'user',
      resourceId: userId,
      detail: { op: 'create', email, roles: roleKeys, scope },
    });
    return { id: userId };
  });
}

export async function updatePlatformUser(
  actor: Principal,
  userId: string,
  input: { status?: 'active' | 'suspended'; displayName?: string; password?: string },
): Promise<{ id: string }> {
  return withSystemContext(async (sql) => {
    await assertNexusUser(sql, userId);
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.status) {
      vals.push(input.status);
      sets.push(`status = $${vals.length}`);
    }
    if (input.displayName !== undefined) {
      vals.push(input.displayName);
      sets.push(`display_name = $${vals.length}`);
    }
    if (input.password) {
      vals.push(await hashPassword(input.password));
      sets.push(`password_hash = $${vals.length}`);
    }
    if (sets.length) {
      vals.push(userId);
      await sql.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
    }
    await audit(actor, {
      action: 'admin.users.manage',
      resourceType: 'user',
      resourceId: userId,
      detail: { op: 'update', status: input.status, renamed: input.displayName !== undefined, password_reset: !!input.password },
    });
    return { id: userId };
  });
}

export async function setPlatformUserRoles(
  actor: Principal,
  userId: string,
  roleKeys: string[],
): Promise<{ id: string }> {
  const keys = [...new Set(roleKeys)];
  if (keys.includes('SuperAdmin') && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant the SuperAdmin role');
  }
  return withSystemContext(async (sql) => {
    await assertNexusUser(sql, userId);
    // Preserve current scope (the set of orgs / all-orgs) while swapping the role set.
    const scope = await currentScope(sql, userId);
    if (scope.mode === 'all' && keys.includes('SuperAdmin') === false && !isSuperAdmin(actor)) {
      // delegated admin cannot retain all-orgs they couldn't grant
      throw Errors.forbidden('only a SuperAdmin can manage an all-organizations user');
    }
    await applyRoles(sql, userId, keys.length ? keys : ['Tier1']);
    await applyScope(sql, userId, keys.length ? keys : ['Tier1'], scope);
    await audit(actor, {
      action: 'admin.users.manage',
      resourceType: 'user',
      resourceId: userId,
      detail: { op: 'set_roles', roles: keys },
    });
    return { id: userId };
  });
}

export async function setPlatformUserScope(
  actor: Principal,
  userId: string,
  scope: ScopeInput,
): Promise<{ id: string }> {
  if (scope.mode === 'all' && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant all-organizations scope');
  }
  if (scope.mode === 'orgs') assertScopeAllowed(actor, scope.orgIds);
  return withSystemContext(async (sql) => {
    await assertNexusUser(sql, userId);
    const roleKeys = await currentRoleKeys(sql, userId);
    await applyScope(sql, userId, roleKeys.length ? roleKeys : ['Tier1'], scope);
    await audit(actor, {
      action: 'admin.users.manage',
      resourceType: 'user',
      resourceId: userId,
      detail: { op: 'set_scope', scope },
    });
    return { id: userId };
  });
}

// ---------- internals ----------

async function assertNexusUser(sql: Sql, userId: string): Promise<void> {
  const { rows } = await sql.query(`SELECT 1 FROM users WHERE id = $1 AND plane = 'nexus'`, [userId]);
  if (!rows[0]) throw Errors.notFound('platform user not found');
}

async function currentRoleKeys(sql: Sql, userId: string): Promise<string[]> {
  const { rows } = await sql.query(
    `SELECT DISTINCT r.key FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.key as string);
}

async function currentScope(sql: Sql, userId: string): Promise<ScopeInput> {
  const { rows } = await sql.query(`SELECT organization_id FROM role_assignments WHERE user_id = $1`, [userId]);
  if (rows.some((r) => r.organization_id == null)) return { mode: 'all' };
  const orgIds = [...new Set(rows.map((r) => r.organization_id as string).filter(Boolean))];
  return { mode: 'orgs', orgIds };
}

/** Replace the user's role assignments, preserving their current scope shape. */
async function applyRoles(sql: Sql, userId: string, roleKeys: string[]): Promise<void> {
  const scope = await currentScope(sql, userId);
  await applyScope(sql, userId, roleKeys, scope);
}

/**
 * Rewrite role_assignments so the user has exactly `roleKeys` at exactly `scope`.
 * - all  -> one org-NULL row per role
 * - orgs -> one row per (role, org)
 */
async function applyScope(sql: Sql, userId: string, roleKeys: string[], scope: ScopeInput): Promise<void> {
  await sql.query(`DELETE FROM role_assignments WHERE user_id = $1`, [userId]);
  const ids = await Promise.all([...new Set(roleKeys)].map((k) => roleIdByKey(sql, k)));
  for (const roleId of ids) {
    if (scope.mode === 'all') {
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1, $2, NULL)
         ON CONFLICT (user_id, role_id, organization_id) DO NOTHING`,
        [userId, roleId],
      );
    } else {
      for (const orgId of [...new Set(scope.orgIds)]) {
        await sql.query(
          `INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, role_id, organization_id) DO NOTHING`,
          [userId, roleId, orgId],
        );
      }
    }
  }
}

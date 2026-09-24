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
//     grant scope WITHIN their own assigned orgs — and may not touch a SuperAdmin or an
//     all-orgs user at all (resetting such a user's password is a privilege escalation).
//   - Nobody can suspend, delete or demote themselves, and the last active SuperAdmin can
//     never be removed.
//   - Every multi-statement change runs in one transaction: a failure part-way through a
//     role rewrite must not leave the user with no role assignments.
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
  sso_linked: boolean;
  roles: string[];
  all_orgs: boolean;
  org_ids: string[];
  created_at: string;
}

interface Target {
  id: string;
  status: string;
  roles: string[];
  scope: ScopeInput;
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

/** Whether `actor` may manage the EXISTING user `target` at all. */
function assertCanManageTarget(actor: Principal, target: Target): void {
  if (isSuperAdmin(actor)) return;
  if (target.roles.includes('SuperAdmin') || target.scope.mode === 'all') {
    throw Errors.forbidden('only a SuperAdmin can manage a SuperAdmin or an all-organizations user');
  }
  assertScopeAllowed(actor, target.scope.orgIds);
}

function assertValidScope(scope: ScopeInput): void {
  // An empty per-org scope writes zero role_assignments rows — the user silently loses every
  // role. That was reachable from the UI (the create default) and reported success.
  if (scope.mode === 'orgs' && scope.orgIds.length === 0) {
    throw Errors.badRequest('select at least one organization, or all organizations');
  }
}

async function inTx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withSystemContext(async (sql) => {
    await sql.query('BEGIN');
    try {
      const out = await fn(sql);
      await sql.query('COMMIT');
      return out;
    } catch (err) {
      await sql.query('ROLLBACK');
      throw err;
    }
  });
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
              (u.external_id IS NOT NULL) AS sso_linked,
              COALESCE(array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
              COALESCE(bool_or(ra.organization_id IS NULL AND ra.role_id IS NOT NULL), false) AS all_orgs,
              COALESCE(array_agg(DISTINCT ra.organization_id) FILTER (WHERE ra.organization_id IS NOT NULL), '{}') AS org_ids
         FROM users u
         LEFT JOIN role_assignments ra ON ra.user_id = u.id
         LEFT JOIN roles r ON r.id = ra.role_id
        WHERE u.plane = 'nexus' AND u.status <> 'deleted'
        GROUP BY u.id
        ORDER BY u.display_name NULLS LAST, u.email`,
    );
    return rows as PlatformUser[];
  });
}

/**
 * The same person as a customer-plane user carries their Entra oid (the tenant roster sync puts
 * it there), and users.external_id is globally UNIQUE — so a staff account for them can never
 * link to Entra while the customer row holds it. Move the identity to the staff account and
 * suspend the customer twin so they cannot sign in to the portal as an EndUser by mistake.
 * Returns the customer row id it released, if any.
 */
export async function releaseCustomerTwin(
  sql: Sql,
  match: { oid?: string | null; email?: string },
): Promise<{ id: string; oid: string | null } | null> {
  const { rows } = await sql.query(
    `SELECT id, external_id FROM users
      WHERE plane = 'customer' AND status <> 'deleted'
        AND (($1::text IS NOT NULL AND external_id = $1) OR ($2::text IS NOT NULL AND lower(email) = lower($2)))
      LIMIT 1`,
    [match.oid ?? null, match.email ?? null],
  );
  const twin = rows[0] as { id: string; external_id: string | null } | undefined;
  if (!twin) return null;
  await sql.query(
    `UPDATE users SET external_id = NULL, status = 'suspended', updated_at = now() WHERE id = $1`,
    [twin.id],
  );
  return { id: twin.id, oid: twin.external_id };
}

export async function createPlatformUser(
  actor: Principal,
  input: { email: string; displayName?: string; roleKeys?: string[]; password?: string; scope?: ScopeInput },
): Promise<{ id: string; releasedCustomerAccount: boolean }> {
  const email = input.email.trim().toLowerCase();
  const roleKeys = [...new Set(input.roleKeys?.length ? input.roleKeys : ['Tier1'])];
  if (roleKeys.includes('SuperAdmin') && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant the SuperAdmin role');
  }
  const scope: ScopeInput = input.scope ?? { mode: 'orgs', orgIds: [] };
  assertValidScope(scope);
  if (scope.mode === 'all' && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant all-organizations scope');
  }
  if (scope.mode === 'orgs') assertScopeAllowed(actor, scope.orgIds);

  const result = await inTx(async (sql) => {
    const dup = await sql.query(
      `SELECT status FROM users WHERE plane='nexus' AND lower(email)=$1 AND status <> 'deleted'`,
      [email],
    );
    if (dup.rows.length) throw Errors.conflict('a platform user with this email already exists');

    // Same person already known as a customer (Entra roster sync): take over their Entra
    // identity so Microsoft sign-in lands on this staff account.
    const twin = await releaseCustomerTwin(sql, { email });

    const pw = input.password ? await hashPassword(input.password) : null;
    const ins = await sql.query(
      `INSERT INTO users (plane, organization_id, email, display_name, password_hash, external_id)
       VALUES ('nexus', NULL, $1, $2, $3, $4) RETURNING id`,
      [email, input.displayName ?? email, pw, twin?.oid ?? null],
    );
    const userId = ins.rows[0].id as string;
    await applyScope(sql, userId, roleKeys, scope);
    return { id: userId, twin };
  });

  if (result.twin) {
    await audit(actor, {
      action: 'admin.users.manage',
      resourceType: 'user',
      resourceId: result.twin.id,
      detail: { op: 'suspend_customer_twin', staff_user: result.id, moved_entra_identity: !!result.twin.oid },
    });
  }
  await audit(actor, {
    action: 'admin.users.manage',
    resourceType: 'user',
    resourceId: result.id,
    detail: { op: 'create', email, roles: roleKeys, scope },
  });
  return { id: result.id, releasedCustomerAccount: !!result.twin };
}

export async function updatePlatformUser(
  actor: Principal,
  userId: string,
  input: { status?: 'active' | 'suspended'; displayName?: string; password?: string },
): Promise<{ id: string }> {
  await inTx(async (sql) => {
    const target = await loadTarget(sql, userId);
    assertCanManageTarget(actor, target);
    if (input.status === 'suspended' && target.status !== 'suspended') {
      if (userId === actor.id) throw Errors.forbidden('you cannot suspend your own account');
      await assertNotLastSuperAdmin(sql, target);
    }
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
  });
  await audit(actor, {
    action: 'admin.users.manage',
    resourceType: 'user',
    resourceId: userId,
    detail: { op: 'update', status: input.status, renamed: input.displayName !== undefined, password_reset: !!input.password },
  });
  return { id: userId };
}

/** Set roles and scope together, atomically — what the edit dialog saves. */
export async function setPlatformUserAccess(
  actor: Principal,
  userId: string,
  input: { roleKeys: string[]; scope: ScopeInput },
): Promise<{ id: string }> {
  const keys = [...new Set(input.roleKeys)];
  if (!keys.length) throw Errors.badRequest('select at least one role');
  assertValidScope(input.scope);
  if (input.scope.mode === 'all' && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant all-organizations scope');
  }
  if (input.scope.mode === 'orgs') assertScopeAllowed(actor, input.scope.orgIds);
  if (keys.includes('SuperAdmin') && !isSuperAdmin(actor)) {
    throw Errors.forbidden('only a SuperAdmin can grant the SuperAdmin role');
  }

  await inTx(async (sql) => {
    const target = await loadTarget(sql, userId);
    assertCanManageTarget(actor, target);
    if (target.roles.includes('SuperAdmin') && !keys.includes('SuperAdmin')) {
      if (userId === actor.id) throw Errors.forbidden('you cannot remove your own SuperAdmin role');
      await assertNotLastSuperAdmin(sql, target);
    }
    await applyScope(sql, userId, keys, input.scope);
  });
  await audit(actor, {
    action: 'admin.users.manage',
    resourceType: 'user',
    resourceId: userId,
    detail: { op: 'set_access', roles: keys, scope: input.scope },
  });
  return { id: userId };
}

export async function setPlatformUserRoles(
  actor: Principal,
  userId: string,
  roleKeys: string[],
): Promise<{ id: string }> {
  // Preserve current scope while swapping the role set.
  const scope = await withSystemContext(async (sql) => (await loadTarget(sql, userId)).scope);
  return setPlatformUserAccess(actor, userId, { roleKeys, scope });
}

export async function setPlatformUserScope(
  actor: Principal,
  userId: string,
  scope: ScopeInput,
): Promise<{ id: string }> {
  const roleKeys = await withSystemContext(async (sql) => (await loadTarget(sql, userId)).roles);
  return setPlatformUserAccess(actor, userId, { roleKeys: roleKeys.length ? roleKeys : ['Tier1'], scope });
}

/**
 * Delete a platform user. An account with no history is removed outright. One that is
 * referenced by tickets, comments, approvals etc. cannot be removed without destroying that
 * history, so it is tombstoned instead: roles and credentials stripped, Entra link and email
 * freed (so the person can be re-created or re-provisioned by SSO), status 'deleted', and it
 * disappears from the list. Existing sessions die either way (loadPrincipal checks status).
 */
export async function deletePlatformUser(
  actor: Principal,
  userId: string,
): Promise<{ id: string; mode: 'deleted' | 'tombstoned' }> {
  if (userId === actor.id) throw Errors.forbidden('you cannot delete your own account');
  const out = await inTx(async (sql) => {
    const target = await loadTarget(sql, userId);
    assertCanManageTarget(actor, target);
    await assertNotLastSuperAdmin(sql, target);
    const email = (await sql.query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email as string;

    await sql.query(`DELETE FROM role_assignments WHERE user_id = $1`, [userId]);
    await sql.query('SAVEPOINT hard_delete');
    try {
      await sql.query(`DELETE FROM users WHERE id = $1`, [userId]);
      return { mode: 'deleted' as const, email };
    } catch (err) {
      if ((err as { code?: string }).code !== '23503') throw err; // only FK violations fall back
      await sql.query('ROLLBACK TO SAVEPOINT hard_delete');
      await sql.query(
        `UPDATE users
            SET status = 'deleted',
                email = 'deleted+' || id::text || '@deleted.invalid',
                display_name = COALESCE(display_name, email) || ' (deleted)',
                external_id = NULL,
                password_hash = NULL,
                updated_at = now()
          WHERE id = $1`,
        [userId],
      );
      return { mode: 'tombstoned' as const, email };
    }
  });
  await audit(actor, {
    action: 'admin.users.manage',
    resourceType: 'user',
    resourceId: userId,
    detail: { op: 'delete', email: out.email, mode: out.mode },
  });
  return { id: userId, mode: out.mode };
}

// ---------- internals ----------

async function loadTarget(sql: Sql, userId: string): Promise<Target> {
  const { rows } = await sql.query(
    `SELECT status FROM users WHERE id = $1 AND plane = 'nexus' AND status <> 'deleted'`,
    [userId],
  );
  if (!rows[0]) throw Errors.notFound('platform user not found');
  const ra = (await sql.query(
    `SELECT r.key, ra.organization_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1`,
    [userId],
  )).rows as Array<{ key: string; organization_id: string | null }>;
  const scope: ScopeInput = ra.some((r) => r.organization_id == null)
    ? { mode: 'all' }
    : { mode: 'orgs', orgIds: [...new Set(ra.map((r) => r.organization_id as string))] };
  return { id: userId, status: rows[0].status, roles: [...new Set(ra.map((r) => r.key))], scope };
}

/** Refuse a change that would leave the platform with no active SuperAdmin. */
async function assertNotLastSuperAdmin(sql: Sql, target: Target): Promise<void> {
  if (!target.roles.includes('SuperAdmin') || target.status !== 'active') return;
  const { rows } = await sql.query(
    `SELECT count(DISTINCT u.id)::int AS n
       FROM users u JOIN role_assignments ra ON ra.user_id = u.id JOIN roles r ON r.id = ra.role_id
      WHERE r.key = 'SuperAdmin' AND u.status = 'active' AND u.id <> $1`,
    [target.id],
  );
  if (rows[0].n === 0) throw Errors.forbidden('this is the last active SuperAdmin');
}

/**
 * Rewrite role_assignments so the user has exactly `roleKeys` at exactly `scope`.
 * - all  -> one org-NULL row per role
 * - orgs -> one row per (role, org)
 */
async function applyScope(sql: Sql, userId: string, roleKeys: string[], scope: ScopeInput): Promise<void> {
  assertValidScope(scope);
  const ids = await Promise.all([...new Set(roleKeys)].map((k) => roleIdByKey(sql, k)));
  await sql.query(`DELETE FROM role_assignments WHERE user_id = $1`, [userId]);
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

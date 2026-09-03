// Account creation, login, and user provisioning.
//   - registerCustomer: self-service signup -> creates an org + Org Admin user (+ local password)
//   - loginLocal: email + password for local accounts
//   - devLogin: email-only quick switch for seeded demo identities (non-production)
//   - provisionUser: an Org Admin creates a user inside their org
// See docs/nexus/02 §E (identity), §D.7 (tenant lifecycle), 01 §C.3.
import { withSystemContext, withOrgContext } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { issueSession } from '../auth/session.js';
import { loadPrincipal, orgContextFor } from '../auth/principal.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { authorize } from '../authz/pdp.js';
import type { OidcIdentity, OidcCustomerIdentity } from '../auth/oidc.js';
import type { Principal, SessionClaims } from '../types.js';

function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

async function roleId(sql: import('../db/pool.js').Sql, key: string): Promise<string> {
  const { rows } = await sql.query('SELECT id FROM roles WHERE key = $1', [key]);
  if (!rows[0]) throw Errors.validation(`role ${key} not seeded`);
  return rows[0].id;
}

export interface RegisterInput {
  organizationName: string;
  email: string;
  displayName?: string;
  password: string;
  cloud?: 'commercial' | 'gcc' | 'gcchigh' | 'azgov';
}

export interface AuthResult {
  token: string;
  principal: Principal;
}

/** Self-service signup: create a customer organization and its first Org Admin. */
export async function registerCustomer(input: RegisterInput): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const domain = emailDomain(email);
  if (!domain) throw Errors.validation('valid email required');
  if (input.password.length < 10) throw Errors.validation('password must be at least 10 characters');

  const result = await withSystemContext(async (sql) => {
    // Reject duplicate customer email.
    const dup = await sql.query("SELECT 1 FROM users WHERE plane='customer' AND email=$1", [email]);
    if (dup.rows.length) throw Errors.conflict('an account with this email already exists');

    await sql.query('BEGIN');
    try {
      const org = await sql.query(
        `INSERT INTO organizations (name, cloud, enclave_id, status)
         VALUES ($1,$2,$3,'active') RETURNING id`,
        // Trim: the name seeds the ticket-number prefix and every email header,
        // so stray whitespace from a signup form must not reach the database.
        [input.organizationName.trim(), input.cloud ?? 'commercial', config.enclave],
      );
      const orgId = org.rows[0].id as string;

      // Register + auto-verify the signup domain (in production this is a DNS/email challenge).
      await sql.query(
        `INSERT INTO organization_domains (organization_id, domain, verified_at, verification_method)
         VALUES ($1,$2, now(), 'self_service_signup') ON CONFLICT (domain) DO NOTHING`,
        [orgId, domain],
      );

      // Seed a posture profile and an SLA policy/calendar for the new org.
      await sql.query(
        `INSERT INTO posture_profiles (organization_id, scope_type, overall_score) VALUES ($1,'org', NULL)`,
        [orgId],
      );

      const pw = await hashPassword(input.password);
      const user = await sql.query(
        `INSERT INTO users (plane, organization_id, email, display_name, password_hash)
         VALUES ('customer',$1,$2,$3,$4) RETURNING id`,
        [orgId, email, input.displayName ?? email, pw],
      );
      const userId = user.rows[0].id as string;

      const adminRole = await roleId(sql, 'OrgAdmin');
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1,$2,$3)`,
        [userId, adminRole, orgId],
      );

      await sql.query('COMMIT');
      return { orgId, userId };
    } catch (err) {
      await sql.query('ROLLBACK');
      throw err;
    }
  });

  const claims: Omit<SessionClaims, 'iat' | 'exp'> = {
    sub: result.userId,
    plane: 'customer',
    email,
    org: result.orgId,
    roles: ['OrgAdmin'],
  };
  const token = issueSession(claims);
  const principal = await loadPrincipal(claims as SessionClaims);

  await audit(principal, {
    action: 'account.registered',
    organizationId: result.orgId,
    resourceType: 'organization',
    resourceId: result.orgId,
    detail: { email },
  });
  publish('organization.created', result.orgId, { org_id: result.orgId, cloud: input.cloud ?? 'commercial' });
  publish('user.created', result.orgId, { user_id: result.userId, org_id: result.orgId, plane: 'customer' });

  return { token, principal };
}

/** Local-account login (email + password). */
export async function loginLocal(email: string, password: string): Promise<AuthResult> {
  const e = email.trim().toLowerCase();
  const row = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT u.id, u.plane, u.organization_id, u.email, u.display_name, u.password_hash, u.status,
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN role_assignments ra ON ra.user_id = u.id
         LEFT JOIN roles r ON r.id = ra.role_id
        WHERE u.email = $1
        GROUP BY u.id`,
      [e],
    );
    return rows[0];
  });
  if (!row || !row.password_hash) throw Errors.unauthorized('invalid credentials');
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw Errors.unauthorized('invalid credentials');
  // Deliberately the SAME message as a bad password: telling an unauthenticated caller that an
  // account exists but is suspended is an account-enumeration oracle. loadPrincipal enforces the
  // same rule on every request, so this is the friendly door rather than the lock.
  if (row.status !== 'active') throw Errors.unauthorized('invalid credentials');

  const claims: Omit<SessionClaims, 'iat' | 'exp'> = {
    sub: row.id,
    plane: row.plane,
    email: row.email,
    org: row.organization_id,
    roles: row.roles,
  };
  const token = issueSession(claims);
  const principal = await loadPrincipal(claims as SessionClaims);
  await audit(principal, { action: 'auth.login', resourceType: 'user', resourceId: row.id });
  return { token, principal };
}

/** Dev-only email login for seeded demo identities (no password). Gated to non-production. */
export async function devLogin(email: string): Promise<AuthResult> {
  if (config.isProduction) throw Errors.forbidden('dev login disabled in production');
  const e = email.trim().toLowerCase();
  const row = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT u.id, u.plane, u.organization_id, u.email,
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN role_assignments ra ON ra.user_id = u.id
         LEFT JOIN roles r ON r.id = ra.role_id
        WHERE u.email = $1
        GROUP BY u.id`,
      [e],
    );
    return rows[0];
  });
  if (!row) throw Errors.notFound('no such demo user');
  const claims: Omit<SessionClaims, 'iat' | 'exp'> = {
    sub: row.id,
    plane: row.plane,
    email: row.email,
    org: row.organization_id,
    roles: row.roles,
  };
  const token = issueSession(claims);
  const principal = await loadPrincipal(claims as SessionClaims);
  return { token, principal };
}

/**
 * Agent-plane login via Entra OIDC. The id_token is already validated by auth/oidc.ts;
 * here we map the Entra identity to a nexus user (by oid, then email), JIT-provisioning
 * one when the token carries an allowed Anchor.* app role, and sync role assignments
 * across all customer orgs (nexus agents have cross-customer scope, like the seed).
 * Ends by minting the same local session JWT as every other login path.
 */
export async function loginOrProvisionAgentOidc(identity: OidcIdentity): Promise<AuthResult> {
  const email = identity.email.trim().toLowerCase();
  const allow = config.oidc.allowedAppRoles;
  // Keep only app roles the deployment permits (empty allow-list = accept any).
  const grantedAppRoles = identity.appRoles.filter((r) => allow.length === 0 || allow.includes(r));
  // Map "Anchor.SecurityAnalyst" -> role key "SecurityAnalyst".
  const roleKeys = [...new Set(grantedAppRoles.map((r) => r.replace(/^Anchor\./, '')))];

  const user = await withSystemContext(async (sql) => {
    // 1) Match by stable Entra oid.
    let row = (
      await sql.query(
        `SELECT id, plane, organization_id, email FROM users WHERE external_id = $1 AND plane = 'nexus'`,
        [identity.oid],
      )
    ).rows[0];

    // 2) Fall back to email; link the oid if found.
    if (!row) {
      const byEmail = (
        await sql.query(
          `SELECT id, plane, organization_id, email, external_id FROM users WHERE plane = 'nexus' AND email = $1`,
          [email],
        )
      ).rows[0];
      if (byEmail) {
        row = byEmail;
        if (!byEmail.external_id) {
          await sql.query(`UPDATE users SET external_id = $1 WHERE id = $2`, [identity.oid, byEmail.id]);
        }
      }
    }

    // 3) JIT-provision a new agent — only if the token grants an allowed role.
    if (!row) {
      if (roleKeys.length === 0) {
        throw Errors.forbidden('no Anchor app role assigned for this user');
      }
      row = (
        await sql.query(
          `INSERT INTO users (plane, organization_id, email, display_name, external_id)
           VALUES ('nexus', NULL, $1, $2, $3)
           RETURNING id, plane, organization_id, email`,
          [email, identity.displayName ?? email, identity.oid],
        )
      ).rows[0];
    }

    // Sync role assignments to match the token (cross-customer scope across all orgs).
    if (roleKeys.length) {
      const orgs = (await sql.query(`SELECT id FROM organizations`)).rows;
      for (const rk of roleKeys) {
        const role = (await sql.query(`SELECT id FROM roles WHERE key = $1`, [rk])).rows[0];
        if (!role) continue;
        for (const o of orgs) {
          await sql.query(
            `INSERT INTO role_assignments (user_id, role_id, organization_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [row.id, role.id, o.id],
          );
        }
      }
    }
    return row;
  });

  const claims: Omit<SessionClaims, 'iat' | 'exp'> = {
    sub: user.id,
    plane: 'nexus',
    email: user.email,
    org: null,
    roles: roleKeys,
  };
  const token = issueSession(claims);
  const principal = await loadPrincipal(claims as SessionClaims);
  await audit(principal, { action: 'auth.oidc_login', resourceType: 'user', resourceId: user.id });
  return { token, principal };
}

/**
 * Customer-plane login via multitenant Entra OIDC. The id_token is already validated by
 * auth/oidc.ts (per-tenant issuer/JWKS). Here we enforce the allow-list — the token's
 * tenant (tid) MUST map to an onboarded organization (organizations.entra_tenant_id) —
 * then match/JIT-provision the user into that org with plane:'customer'. RLS/ABAC scope
 * them to their org automatically.
 */
export async function loginOrProvisionCustomerOidc(
  identity: OidcCustomerIdentity,
): Promise<AuthResult> {
  const email = identity.email.trim().toLowerCase();
  const roleKey = config.oidcCustomer.defaultRoleKey;

  const user = await withSystemContext(async (sql) => {
    // Allow-list: the customer tenant must be mapped to an Anchor org.
    const org = (
      await sql.query(`SELECT id FROM organizations WHERE entra_tenant_id = $1`, [identity.tid])
    ).rows[0];
    if (!org) {
      throw Errors.forbidden(`organization not onboarded for SSO (tenant ${identity.tid})`);
    }

    // Match by Entra oid, then by email within the org; link the oid if found.
    let row = (
      await sql.query(
        `SELECT id, plane, organization_id, email FROM users WHERE external_id = $1 AND plane = 'customer'`,
        [identity.oid],
      )
    ).rows[0];
    if (!row) {
      const byEmail = (
        await sql.query(
          `SELECT id, plane, organization_id, email, external_id
             FROM users WHERE plane = 'customer' AND organization_id = $1 AND email = $2`,
          [org.id, email],
        )
      ).rows[0];
      if (byEmail) {
        row = byEmail;
        if (!byEmail.external_id) {
          await sql.query(`UPDATE users SET external_id = $1 WHERE id = $2`, [identity.oid, byEmail.id]);
        }
      }
    }

    // JIT-provision into the mapped org.
    if (!row) {
      row = (
        await sql.query(
          `INSERT INTO users (plane, organization_id, email, display_name, external_id)
           VALUES ('customer', $1, $2, $3, $4)
           RETURNING id, plane, organization_id, email`,
          [org.id, email, identity.displayName ?? email, identity.oid],
        )
      ).rows[0];
    }

    // Ensure the default role assignment within their org.
    const role = (await sql.query(`SELECT id FROM roles WHERE key = $1`, [roleKey])).rows[0];
    if (role) {
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [row.id, role.id, org.id],
      );
    }
    return row;
  });

  const claims: Omit<SessionClaims, 'iat' | 'exp'> = {
    sub: user.id,
    plane: 'customer',
    email: user.email,
    org: user.organization_id,
    roles: [roleKey],
  };
  const token = issueSession(claims);
  const principal = await loadPrincipal(claims as SessionClaims);
  await audit(principal, { action: 'auth.oidc_login', resourceType: 'user', resourceId: user.id });
  return { token, principal };
}

/** Org Admin provisions a user inside their own organization. */
export async function provisionUser(
  actor: Principal,
  orgId: string,
  input: { email: string; displayName?: string; roleKey?: string; password?: string },
): Promise<{ id: string }> {
  const email = input.email.trim().toLowerCase();
  return withSystemContext(async (sql) => {
    const dup = await sql.query(
      "SELECT 1 FROM users WHERE plane='customer' AND email=$1",
      [email],
    );
    if (dup.rows.length) throw Errors.conflict('user already exists');

    const pw = input.password ? await hashPassword(input.password) : null;
    const user = await sql.query(
      `INSERT INTO users (plane, organization_id, email, display_name, password_hash)
       VALUES ('customer',$1,$2,$3,$4) RETURNING id`,
      [orgId, email, input.displayName ?? email, pw],
    );
    const userId = user.rows[0].id as string;
    const role = await roleId(sql, input.roleKey ?? 'EndUser');
    await sql.query(
      `INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1,$2,$3)`,
      [userId, role, orgId],
    );
    await audit(actor, {
      action: 'customer.admin.manage_users',
      organizationId: orgId,
      resourceType: 'user',
      resourceId: userId,
      detail: { email, role: input.roleKey ?? 'EndUser' },
    });
    publish('user.created', orgId, { user_id: userId, org_id: orgId, plane: 'customer' });
    return { id: userId };
  });
}

/** Which org a people-picker search runs in: customers are pinned to their own org. Pure. */
export function resolveSearchOrg(actor: Principal, organizationId?: string): string | null {
  if (actor.plane === 'customer') return actor.organizationId ?? null;
  return organizationId ?? null;
}

export interface UserHit {
  id: string;
  display_name: string | null;
  email: string;
}

/** Type-ahead user search for people pickers, scoped to one org and RLS-enforced. */
export async function searchUsers(actor: Principal, q: string, organizationId?: string): Promise<UserHit[]> {
  const orgId = resolveSearchOrg(actor, organizationId);
  if (!orgId) return [];
  authorize(actor, 'ticket.create', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const term = (q ?? '').trim();
    const { rows } = await sql.query(
      `SELECT id, display_name, email FROM users
        WHERE organization_id = $1 AND status = 'active'
          AND ($2 = '' OR display_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
        ORDER BY display_name NULLS LAST LIMIT 10`,
      [orgId, term],
    );
    return rows as UserHit[];
  });
}

export async function getOrganization(actor: Principal, id: string) {
  authorize(actor, 'org.read', { organizationId: id });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const org = (await sql.query('SELECT id, name, cloud, status, data_boundary, created_at FROM organizations WHERE id=$1', [id])).rows[0];
    if (!org) throw Errors.notFound('organization not found');
    const userCount = (await sql.query('SELECT count(*)::int AS n FROM users WHERE organization_id=$1', [id])).rows[0].n;
    const openTickets = (await sql.query(`SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1 AND status NOT IN ('closed','resolved')`, [id])).rows[0].n;
    return { ...org, user_count: userCount, open_tickets: openTickets };
  });
}

export async function listOrganizationUsers(actor: Principal, id: string) {
  authorize(actor, 'org.read', { organizationId: id });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT id, email, display_name, status FROM users WHERE organization_id=$1 ORDER BY email', [id]);
    return rows;
  });
}

export interface UpdateOrgInput { name?: string; cloud?: 'commercial' | 'gcc' | 'gcchigh' | 'azgov'; dataBoundary?: string; }

/**
 * Admin: create a customer organization (no user) and optionally onboard it for SSO by
 * mapping its Entra tenant. Used to onboard external customer tenants for multitenant OIDC
 * (the tid allow-list). Caller must hold org.manage (checked in the route). Uses the system
 * context because there is no org/RLS scope yet.
 */
export async function createOrganizationAdmin(
  actor: Principal,
  input: { name: string; cloud?: 'commercial' | 'gcc' | 'gcchigh' | 'azgov'; entraTenantId?: string },
): Promise<{ id: string; name: string; cloud: string; entra_tenant_id: string | null }> {
  const cloud = input.cloud ?? 'gcchigh';
  const enclaveId = cloud === 'gcchigh' || cloud === 'azgov' ? 'gov' : 'commercial';
  return withSystemContext(async (sql) => {
    if (input.entraTenantId) {
      const dup = (
        await sql.query(`SELECT id, name FROM organizations WHERE entra_tenant_id = $1`, [input.entraTenantId])
      ).rows[0];
      if (dup) throw Errors.badRequest(`tenant already onboarded to organization "${dup.name}"`);
    }
    const { rows } = await sql.query(
      `INSERT INTO organizations (name, cloud, enclave_id, status, entra_tenant_id)
       VALUES ($1, $2, $3, 'active', $4)
       RETURNING id, name, cloud, entra_tenant_id`,
      [input.name.trim(), cloud, enclaveId, input.entraTenantId ?? null],
    );
    await audit(actor, {
      action: 'org.create',
      organizationId: rows[0].id,
      resourceType: 'organization',
      resourceId: rows[0].id,
      detail: { entra_tenant_id: input.entraTenantId ?? null },
    });
    return rows[0];
  });
}

/**
 * Admin: delete an organization. Safety: refuses if any users belong to it (so a real
 * customer org can't be removed). Used to tidy up mistaken/test onboardings. System context.
 */
export async function deleteOrganizationAdmin(
  actor: Principal,
  id: string,
  force = false,
): Promise<{ deleted: true; id: string; name: string }> {
  return withSystemContext(async (sql) => {
    const org = (await sql.query(`SELECT id, name FROM organizations WHERE id = $1`, [id])).rows[0];
    if (!org) throw Errors.notFound('organization not found');
    const n = (await sql.query(`SELECT count(*)::int AS n FROM users WHERE organization_id = $1`, [id])).rows[0].n;
    if (n > 0 && !force) {
      throw Errors.badRequest(`organization "${org.name}" has ${n} user(s); pass force=true to remove them too`);
    }
    // Clear org-scoped rows in tables whose FK to organizations is NOT ON DELETE CASCADE
    // (tickets last, since the others reference it). Remaining child tables cascade.
    for (const t of [
      'notification_deliveries',
      'oncall_pages',
      'sla_instances',
      'ticket_comments',
      'ticket_events',
      'tickets',
    ]) {
      await sql.query(`DELETE FROM ${t} WHERE organization_id = $1`, [id]);
    }
    // force: remove the org's users too (role_assignments cascade on user delete).
    if (force) await sql.query(`DELETE FROM users WHERE organization_id = $1`, [id]);
    await sql.query(`DELETE FROM organizations WHERE id = $1`, [id]);
    await audit(actor, {
      action: 'org.delete',
      organizationId: id,
      resourceType: 'organization',
      resourceId: id,
      detail: { name: org.name },
    });
    return { deleted: true, id, name: org.name };
  });
}

/** Admin (system context): org detail incl. SSO tenant + counts, for any org. */
export async function getOrganizationAdmin(id: string) {
  return withSystemContext(async (sql) => {
    const org = (
      await sql.query(
        `SELECT id, name, cloud, status, data_boundary, entra_tenant_id, created_at FROM organizations WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!org) throw Errors.notFound('organization not found');
    const userCount = (await sql.query('SELECT count(*)::int AS n FROM users WHERE organization_id = $1', [id])).rows[0].n;
    const openTickets = (
      await sql.query(
        `SELECT count(*)::int AS n FROM tickets WHERE organization_id = $1 AND status NOT IN ('closed','resolved')`,
        [id],
      )
    ).rows[0].n;
    return { ...org, user_count: userCount, open_tickets: openTickets };
  });
}

/** Admin (system context): list users in any org, with their role keys. */
export async function listOrganizationUsersAdmin(orgId: string) {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT u.id, u.email, u.display_name, u.status,
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN role_assignments ra ON ra.user_id = u.id AND ra.organization_id = $1
         LEFT JOIN roles r ON r.id = ra.role_id
        WHERE u.organization_id = $1
        GROUP BY u.id
        ORDER BY u.email`,
      [orgId],
    );
    return rows;
  });
}

/** Admin: update org fields incl. SSO tenant (entra_tenant_id) + status. System context. */
export async function updateOrganizationAdmin(
  actor: Principal,
  id: string,
  input: { name?: string; cloud?: string; entraTenantId?: string | null; status?: string },
) {
  return withSystemContext(async (sql) => {
    const cur = (
      await sql.query(`SELECT id, name, cloud, status, entra_tenant_id FROM organizations WHERE id = $1`, [id])
    ).rows[0];
    if (!cur) throw Errors.notFound('organization not found');
    if (input.entraTenantId) {
      const dup = (
        await sql.query(`SELECT name FROM organizations WHERE entra_tenant_id = $1 AND id <> $2`, [input.entraTenantId, id])
      ).rows[0];
      if (dup) throw Errors.badRequest(`tenant already onboarded to organization "${dup.name}"`);
    }
    const { rows } = await sql.query(
      `UPDATE organizations SET name = $1, cloud = $2, status = $3, entra_tenant_id = $4 WHERE id = $5
       RETURNING id, name, cloud, status, entra_tenant_id`,
      [
        input.name ?? cur.name,
        input.cloud ?? cur.cloud,
        input.status ?? cur.status,
        input.entraTenantId === undefined ? cur.entra_tenant_id : input.entraTenantId,
        id,
      ],
    );
    await audit(actor, { action: 'org.update', organizationId: id, resourceType: 'organization', resourceId: id });
    return rows[0];
  });
}

/** Admin: change a user's status and/or role within an org. System context. */
export async function updateOrgUserAdmin(
  actor: Principal,
  orgId: string,
  userId: string,
  input: { status?: 'active' | 'suspended'; roleKey?: string },
) {
  return withSystemContext(async (sql) => {
    const u = (await sql.query(`SELECT id, email FROM users WHERE id = $1 AND organization_id = $2`, [userId, orgId])).rows[0];
    if (!u) throw Errors.notFound('user not found');
    if (input.status) await sql.query(`UPDATE users SET status = $1 WHERE id = $2`, [input.status, userId]);
    if (input.roleKey) {
      await sql.query(`DELETE FROM role_assignments WHERE user_id = $1 AND organization_id = $2`, [userId, orgId]);
      const rid = await roleId(sql, input.roleKey);
      await sql.query(
        `INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, rid, orgId],
      );
    }
    await audit(actor, {
      action: 'customer.admin.manage_users',
      organizationId: orgId,
      resourceType: 'user',
      resourceId: userId,
      detail: { status: input.status, role: input.roleKey },
    });
    return { id: userId };
  });
}

/** Admin: deactivate (suspend) a user — reversible; safer than a hard delete with FK history. */
export async function removeOrgUserAdmin(actor: Principal, orgId: string, userId: string) {
  return withSystemContext(async (sql) => {
    const u = (await sql.query(`SELECT id, email FROM users WHERE id = $1 AND organization_id = $2`, [userId, orgId])).rows[0];
    if (!u) throw Errors.notFound('user not found');
    await sql.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userId]);
    await audit(actor, {
      action: 'customer.admin.manage_users',
      organizationId: orgId,
      resourceType: 'user',
      resourceId: userId,
      detail: { removed: true, email: u.email },
    });
    return { id: userId, status: 'suspended' };
  });
}

export async function updateOrganization(actor: Principal, id: string, input: UpdateOrgInput) {
  authorize(actor, 'org.manage', { organizationId: id });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT id, name, cloud, status, data_boundary, created_at FROM organizations WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('organization not found');
    const { rows } = await sql.query(
      `UPDATE organizations SET name=$1, cloud=$2, data_boundary=$3 WHERE id=$4
       RETURNING id, name, cloud, status, data_boundary, created_at`,
      [input.name ?? cur.name, input.cloud ?? cur.cloud, input.dataBoundary ?? cur.data_boundary, id],
    );
    await audit(actor, { action: 'org.update', organizationId: id, resourceType: 'organization', resourceId: id });
    return rows[0];
  });
}

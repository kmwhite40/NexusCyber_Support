// JIT elevation & break-glass (docs/nexus/02 §E.11). Pure helpers (unit-tested) plus
// DB-backed request/approve/break-glass. Platform-internal: accessed via the system
// context, with authorization enforced in code (mirrors automation_rules).
import { withSystemContext, type Sql } from '../db/pool.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { createPage } from './oncall.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export interface GrantRow {
  id: string;
  user_id: string;
  granted_permissions: string[];
  status: string;
  break_glass: boolean;
  expires_at: string | null;
}

/** Is a grant currently effective? Active status and not past expiry. Pure. */
export function isGrantActive(g: GrantRow, now = new Date()): boolean {
  if (g.status !== 'active') return false;
  if (g.expires_at === null) return true;
  return new Date(g.expires_at).getTime() > now.getTime();
}

/** Union base permissions with all active grants' permissions (deduped). Pure. */
export function mergeGrantedPermissions(base: string[], grants: GrantRow[], now = new Date()): string[] {
  const set = new Set(base);
  for (const g of grants) if (isGrantActive(g, now)) for (const p of g.granted_permissions) set.add(p);
  return [...set];
}

const DEFAULT_TTL_MINUTES = 60;

export interface RequestElevationInput {
  permissions: string[];
  reason: string;
  organizationId?: string | null;
}

/** Request a time-boxed elevation. Approved separately (SoD). */
export async function requestElevation(actor: Principal, input: RequestElevationInput) {
  authorize(actor, 'elevation.request', { organizationId: input.organizationId ?? undefined });
  if (!input.permissions.length) throw Errors.badRequest('at least one permission is required');
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO elevation_grants (organization_id, user_id, granted_permissions, reason, requested_by, status)
       VALUES ($1,$2,$3,$4,$5,'requested') RETURNING *`,
      [input.organizationId ?? null, actor.id, input.permissions, input.reason, actor.id],
    );
    const g = rows[0];
    await audit(actor, { action: 'elevation.request', organizationId: g.organization_id, resourceType: 'elevation_grant', resourceId: g.id, detail: { permissions: input.permissions } });
    publish('elevation.requested', g.organization_id, { grant_id: g.id, user_id: actor.id });
    return g;
  });
}

/** Approve a requested elevation, activating it with a TTL. SoD enforced. */
export async function approveElevation(actor: Principal, grantId: string, ttlMinutes = DEFAULT_TTL_MINUTES) {
  authorize(actor, 'elevation.approve');
  return withSystemContext(async (sql) => {
    const g = (await sql.query('SELECT * FROM elevation_grants WHERE id=$1', [grantId])).rows[0];
    if (!g) throw Errors.notFound('grant not found');
    if (g.status !== 'requested') throw Errors.conflict(`grant already ${g.status}`);
    if (g.requested_by === actor.id) throw Errors.forbidden('separation of duties: requester cannot approve');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    await sql.query("UPDATE elevation_grants SET status='active', approver_id=$1, expires_at=$2 WHERE id=$3", [actor.id, expiresAt, grantId]);
    await audit(actor, { action: 'elevation.approve', organizationId: g.organization_id, resourceType: 'elevation_grant', resourceId: grantId, detail: { expiresAt } });
    publish('elevation.activated', g.organization_id, { grant_id: grantId, user_id: g.user_id, expires_at: expiresAt });
    return { status: 'active', expires_at: expiresAt };
  });
}

/** Break-glass: immediate, self-approved, LOUD elevation (critical audit + on-call page). */
export async function breakGlass(actor: Principal, input: RequestElevationInput, ttlMinutes = DEFAULT_TTL_MINUTES) {
  authorize(actor, 'elevation.break_glass', { organizationId: input.organizationId ?? undefined });
  if (!input.permissions.length) throw Errors.badRequest('at least one permission is required');
  const grant = await withSystemContext(async (sql) => {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const { rows } = await sql.query(
      `INSERT INTO elevation_grants (organization_id, user_id, granted_permissions, reason, requested_by, approver_id, break_glass, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$5,true,'active',$6) RETURNING *`,
      [input.organizationId ?? null, actor.id, input.permissions, input.reason, actor.id, expiresAt],
    );
    return rows[0];
  });
  await audit(actor, { action: 'elevation.break_glass', organizationId: grant.organization_id, resourceType: 'elevation_grant', resourceId: grant.id, scope: 'critical', detail: { permissions: input.permissions, reason: input.reason } });
  publish('elevation.break_glass', grant.organization_id, { grant_id: grant.id, user_id: actor.id });
  // Page on-call so break-glass is never silent.
  try {
    await createPage(actor, { organizationId: grant.organization_id ?? undefined, severity: 'Sev1' });
  } catch {
    // Paging is best-effort; the critical audit event is the durable record.
  }
  return grant;
}

/** Active, non-expired grants for a user (read by loadPrincipal). */
// Pass `existing` when calling from within another withSystemContext (e.g.
// loadPrincipal) so we reuse that connection instead of acquiring a second one.
// Nesting withSystemContext deadlocks the bounded admin pool under concurrency.
export async function activeGrantsFor(userId: string, existing?: Sql): Promise<GrantRow[]> {
  const run = async (sql: Sql): Promise<GrantRow[]> => {
    const { rows } = await sql.query(
      `SELECT id, user_id, granted_permissions, status, break_glass,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
         FROM elevation_grants
        WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    );
    return rows as GrantRow[];
  };
  return existing ? run(existing) : withSystemContext(run);
}

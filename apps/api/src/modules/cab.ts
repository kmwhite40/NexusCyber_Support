// Change Advisory Board (CAB) administration: the standing board (members, chair,
// quorum, threshold), blackout windows, and change templates. Voting itself lives
// in changes.ts; this module owns board CONFIG + the roster used at submit time.
//
// Boards/blackouts/templates are org-scoped with an org-NULL GLOBAL default. Migration
// 0052's RLS policy makes org-NULL rows visible from every org context (that is the point
// — every tenant inherits the global default), which means RLS alone cannot protect them
// from writes. So every mutation here resolves an explicit scope first: `cab.manage` for
// the actor's own org, and the platform-wide `cab.manage.global` for any org-NULL row.
import { withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';
import type { Threshold } from './changes.js';

// ---- Scope resolution (pure) ----

/** The slice of a Principal that scope resolution depends on. */
export interface CabScopeActor {
  plane: 'nexus' | 'customer';
  organizationId: string | null;
  /**
   * Holds `cab.manage.global` AT PLATFORM SCOPE — see `holdsGlobalCabGrant`, which is what
   * every caller must compute this with. Not simply `can(actor,'cab.manage.global')`.
   */
  canManageGlobal: boolean;
}

export type ScopeDecision =
  | { ok: true; organizationId: string | null }
  | { ok: false; reason: string };

/**
 * Which scope does a CAB *write* target, and may this actor write it? Pure.
 *
 * A global (organization_id IS NULL) board/blackout/template is inherited by every
 * organization, so creating, editing, or deleting one is a platform-wide act and needs
 * `cab.manage.global`. Note the default for a nexus caller who names no org is GLOBAL —
 * exactly the case that must be gated, and the reason this is not left implicit.
 */
export function resolveWriteScope(actor: CabScopeActor, requested?: string | null): ScopeDecision {
  if (actor.plane === 'customer') {
    if (!actor.organizationId) return { ok: false, reason: 'customer principal has no organization' };
    // A customer admin manages exactly one board: their own. They may not reach global.
    if (requested === null) {
      return { ok: false, reason: 'global CAB configuration requires cab.manage.global' };
    }
    if (requested !== undefined && requested !== actor.organizationId) {
      return { ok: false, reason: 'out of organization scope' };
    }
    return { ok: true, organizationId: actor.organizationId };
  }
  // Nexus plane: an explicit org targets that org (the PDP then checks assignment scope).
  if (typeof requested === 'string' && requested) return { ok: true, organizationId: requested };
  if (!actor.canManageGlobal) {
    return {
      ok: false,
      reason: 'global CAB configuration requires cab.manage.global (name an organizationId to configure a single org)',
    };
  }
  return { ok: true, organizationId: null };
}

/**
 * Which scope does a CAB *read* target? Pure. Reads are not gated on `cab.manage.global`
 * — global rows are meant to be visible to the orgs that inherit them — but the caller
 * still needs `cab.manage` (enforced by the callers below).
 */
export function resolveReadScope(actor: CabScopeActor, requested?: string | null): ScopeDecision {
  if (actor.plane === 'customer') {
    if (!actor.organizationId) return { ok: false, reason: 'customer principal has no organization' };
    if (requested !== undefined && requested !== null && requested !== actor.organizationId) {
      return { ok: false, reason: 'out of organization scope' };
    }
    return { ok: true, organizationId: actor.organizationId };
  }
  return { ok: true, organizationId: typeof requested === 'string' && requested ? requested : null };
}

/**
 * Does this actor hold the platform-wide CAB grant AT PLATFORM SCOPE? Pure.
 *
 * `can(actor, 'cab.manage.global')` alone is scope-blind: with no resource context
 * `pdp.ts`'s `inOrgScope` short-circuits to true, so the answer is pure RBAC. That is safe
 * only while 0059 grants the permission exclusively to `admin.superuser` holders — and
 * 0059's own comment invites granting it to non-superuser platform admins, at which point
 * a SINGLE-ORG role assignment would carry platform-wide CAB write. Global CAB rows are
 * inherited by every tenant, so the grant has to be paired with genuinely platform-wide
 * standing: an org-NULL (all-orgs) assignment, or the superuser wildcard.
 */
export function holdsGlobalCabGrant(actor: { permissions: string[]; allOrgs: boolean }): boolean {
  const superuser = actor.permissions.includes('admin.superuser');
  if (!superuser && !actor.permissions.includes('cab.manage.global')) return false;
  return superuser || actor.allOrgs;
}

/**
 * Would letting this actor configure the CAB break segregation of duties? Pure.
 *
 * Whoever composes the board — and whoever authors the pre-approved standard-change
 * templates — decides who judges production changes and which work skips judgement
 * entirely. A principal who can also RAISE changes holds both ends of that: add an ally,
 * set quorum to 1, submit. Migration 0061 removes the overlap from the shipped roles; this
 * is the runtime backstop, so stacking a raiser role onto a CAB administrator does not
 * quietly reopen it.
 *
 * Deliberately reads the LITERAL permission list rather than `can()`: the platform
 * superuser wildcard would otherwise match `change.create` and lock break-glass admins out
 * of CAB configuration entirely. A superuser is outside the SoD model by construction and
 * every CAB write they make is audited by actor.
 */
export function raisesChanges(actor: { permissions: string[] }): boolean {
  return actor.permissions.includes('change.create');
}

const SOD_REASON =
  'segregation of duties: a principal that can raise changes (change.create) may not configure the CAB that judges them — use a role holding cab.manage without change.create';

function scopeActor(actor: Principal): CabScopeActor {
  return {
    plane: actor.plane,
    organizationId: actor.organizationId,
    canManageGlobal: holdsGlobalCabGrant(actor),
  };
}

/** Resolve + authorize a CAB write. Returns the organization_id the row must carry. */
function authorizeWrite(actor: Principal, requested?: string | null): string | null {
  authorize(actor, 'cab.manage'); // RBAC half first, so non-holders get the plain reason
  const d = resolveWriteScope(scopeActor(actor), requested);
  if (!d.ok) throw Errors.forbidden(d.reason);
  authorize(actor, 'cab.manage', { organizationId: d.organizationId }); // ABAC half
  return d.organizationId;
}

/** Resolve + authorize a CAB read. Returns the organization_id whose rows to show. */
function authorizeRead(actor: Principal, requested?: string | null): string | null {
  authorize(actor, 'cab.manage');
  const d = resolveReadScope(scopeActor(actor), requested);
  if (!d.ok) throw Errors.forbidden(d.reason);
  authorize(actor, 'cab.manage', { organizationId: d.organizationId });
  return d.organizationId;
}

// ---- Roster resolution ----

/** Resolve the board that governs an org's changes: the org's default, else the global default. */
export async function resolveBoard(sql: Sql, orgId: string | null) {
  const board = (
    await sql.query(
      `SELECT * FROM cab_boards
        WHERE is_default AND (organization_id = $1 OR organization_id IS NULL)
        ORDER BY (organization_id IS NOT NULL) DESC
        LIMIT 1`,
      [orgId],
    )
  ).rows[0];
  if (!board) return null;
  const members = (
    await sql.query('SELECT user_id, role, weight FROM cab_board_members WHERE board_id=$1 ORDER BY role DESC', [board.id])
  ).rows;
  return { ...board, members };
}

/** The standing-board roster (voters) for an org. Used by changes.ts at submit time. */
export async function rosterFor(sql: Sql, orgId: string | null): Promise<Array<{ user_id: string; weight: number }>> {
  const board = await resolveBoard(sql, orgId);
  return (board?.members ?? []).map((m: any) => ({ user_id: m.user_id, weight: m.weight }));
}

export interface BoardInput {
  organizationId?: string | null;
  name?: string;
  chairId?: string | null;
  quorum?: number;
  threshold?: Threshold;
  members?: Array<{ userId: string; role?: 'chair' | 'member'; weight?: number }>;
}

/** Read the org's standing board (cab.manage). */
export async function getBoard(actor: Principal, orgId?: string | null) {
  const org = authorizeRead(actor, orgId);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const board = await resolveBoard(sql, org);
    return board ?? { organization_id: org, name: 'Change Advisory Board', quorum: 1, threshold: 'majority', members: [] };
  });
}

/** Create or update the org's default standing board and its members (cab.manage). */
export async function putBoard(actor: Principal, input: BoardInput) {
  // Composing the board is the act SoD exists to separate from raising changes.
  if (raisesChanges(actor)) throw Errors.forbidden(SOD_REASON);
  const org = authorizeWrite(actor, input.organizationId);
  const members = input.members ?? [];
  return withOrgContext(orgContextFor(actor), async (sql) => {
    let board = (
      await sql.query('SELECT * FROM cab_boards WHERE is_default AND organization_id IS NOT DISTINCT FROM $1 LIMIT 1', [org])
    ).rows[0];
    const chairId = input.chairId ?? members.find((m) => m.role === 'chair')?.userId ?? null;
    if (!board) {
      board = (
        await sql.query(
          `INSERT INTO cab_boards (organization_id, name, chair_id, quorum, threshold, is_default)
           VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
          [org, input.name ?? 'Change Advisory Board', chairId, input.quorum ?? 1, input.threshold ?? 'majority'],
        )
      ).rows[0];
    } else {
      board = (
        await sql.query(
          `UPDATE cab_boards SET name=COALESCE($2,name), chair_id=$3, quorum=COALESCE($4,quorum),
             threshold=COALESCE($5,threshold), updated_at=now()
           WHERE id=$1 AND organization_id IS NOT DISTINCT FROM $6 RETURNING *`,
          [board.id, input.name ?? null, chairId, input.quorum ?? null, input.threshold ?? null, org],
        )
      ).rows[0];
      if (!board) throw Errors.notFound('CAB board not found in this scope');
    }
    // Replace the membership set (the board itself is already scope-checked above).
    await sql.query('DELETE FROM cab_board_members WHERE board_id=$1', [board.id]);
    for (const m of members) {
      await sql.query(
        `INSERT INTO cab_board_members (board_id, user_id, role, weight) VALUES ($1,$2,$3,$4)
         ON CONFLICT (board_id, user_id) DO UPDATE SET role=EXCLUDED.role, weight=EXCLUDED.weight`,
        [board.id, m.userId, m.role ?? (m.userId === chairId ? 'chair' : 'member'), m.weight ?? 1],
      );
    }
    await audit(actor, { action: 'cab.board.update', organizationId: org, resourceType: 'cab_board', resourceId: board.id, detail: { global: org === null, members: members.length, quorum: board.quorum, threshold: board.threshold } });
    return resolveBoard(sql, org);
  });
}

// ---- Blackout windows ----

export async function listBlackouts(actor: Principal, orgId?: string | null) {
  const org = authorizeRead(actor, orgId);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    return (
      await sql.query(
        'SELECT * FROM change_blackouts WHERE organization_id IS NULL OR organization_id = $1 ORDER BY starts_at',
        [org],
      )
    ).rows;
  });
}

export async function createBlackout(
  actor: Principal,
  input: { organizationId?: string | null; name: string; startsAt: string; endsAt: string; reason?: string },
) {
  const org = authorizeWrite(actor, input.organizationId);
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw Errors.badRequest('endsAt must be after startsAt');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const row = (
      await sql.query(
        `INSERT INTO change_blackouts (organization_id, name, starts_at, ends_at, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [org, input.name, input.startsAt, input.endsAt, input.reason ?? null, actor.id],
      )
    ).rows[0];
    await audit(actor, { action: 'cab.blackout.create', organizationId: org, resourceType: 'change_blackout', resourceId: row.id, detail: { global: org === null } });
    return row;
  });
}

export async function deleteBlackout(actor: Principal, id: string) {
  authorize(actor, 'cab.manage');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    // Authorize against the row's OWN org, not the caller's — a global row needs the
    // platform-wide grant, and the audit must name the org the row actually belonged to.
    const row = (await sql.query('SELECT id, organization_id FROM change_blackouts WHERE id=$1', [id])).rows[0];
    if (!row) throw Errors.notFound('blackout not found');
    const org = authorizeWrite(actor, row.organization_id);
    await sql.query('DELETE FROM change_blackouts WHERE id=$1 AND organization_id IS NOT DISTINCT FROM $2', [id, org]);
    await audit(actor, { action: 'cab.blackout.delete', organizationId: org, resourceType: 'change_blackout', resourceId: id, detail: { global: org === null } });
    return { deleted: true };
  });
}

// ---- Change templates ----

export async function listTemplates(actor: Principal, orgId?: string | null) {
  const org = authorizeRead(actor, orgId);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    return (
      await sql.query(
        'SELECT * FROM change_templates WHERE organization_id IS NULL OR organization_id = $1 ORDER BY name',
        [org],
      )
    ).rows;
  });
}

export async function createTemplate(
  actor: Principal,
  input: {
    organizationId?: string | null; name: string; changeType?: string; risk?: string;
    impact?: string; likelihood?: string; description?: string;
    implementationPlan?: string; testPlan?: string; backoutPlan?: string;
  },
) {
  // A `standard` template is a standing PRE-APPROVAL: changes created from it skip the CAB
  // entirely. Authoring one is therefore a CAB act, and closed to anyone who raises changes.
  if ((input.changeType ?? 'normal') === 'standard' && raisesChanges(actor)) {
    throw Errors.forbidden(SOD_REASON);
  }
  const org = authorizeWrite(actor, input.organizationId);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const row = (
      await sql.query(
        `INSERT INTO change_templates
           (organization_id, name, change_type, risk, impact, likelihood, description, implementation_plan, test_plan, backout_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        // Defaults to 'normal': a template that pre-approves work must say so deliberately.
        [org, input.name, input.changeType ?? 'normal', input.risk ?? 'low', input.impact ?? null, input.likelihood ?? null,
         input.description ?? null, input.implementationPlan ?? null, input.testPlan ?? null, input.backoutPlan ?? null],
      )
    ).rows[0];
    await audit(actor, { action: 'cab.template.create', organizationId: org, resourceType: 'change_template', resourceId: row.id, detail: { global: org === null } });
    return row;
  });
}

export async function deleteTemplate(actor: Principal, id: string) {
  authorize(actor, 'cab.manage');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const row = (await sql.query('SELECT id, organization_id FROM change_templates WHERE id=$1', [id])).rows[0];
    if (!row) throw Errors.notFound('template not found');
    const org = authorizeWrite(actor, row.organization_id);
    await sql.query('DELETE FROM change_templates WHERE id=$1 AND organization_id IS NOT DISTINCT FROM $2', [id, org]);
    await audit(actor, { action: 'cab.template.delete', organizationId: org, resourceType: 'change_template', resourceId: id, detail: { global: org === null } });
    return { deleted: true };
  });
}

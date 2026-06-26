// Change Advisory Board (CAB) administration: the standing board (members, chair,
// quorum, threshold), blackout windows, and change templates. Voting itself lives
// in changes.ts; this module owns board CONFIG + the roster used at submit time.
// Boards/blackouts/templates are org-scoped with an org-NULL global default.
import { withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';
import type { Threshold } from './changes.js';

/** Org the actor is administering: their own org (customer) or an explicit/global org (nexus). */
function targetOrg(actor: Principal, orgId?: string | null): string | null {
  if (actor.plane === 'customer') return actor.organizationId;
  return orgId ?? null; // nexus: explicit org, or null = global default
}

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
  authorize(actor, 'cab.manage');
  const org = targetOrg(actor, orgId);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const board = await resolveBoard(sql, org);
    return board ?? { organization_id: org, name: 'Change Advisory Board', quorum: 1, threshold: 'majority', members: [] };
  });
}

/** Create or update the org's default standing board and its members (cab.manage). */
export async function putBoard(actor: Principal, input: BoardInput) {
  authorize(actor, 'cab.manage');
  const org = targetOrg(actor, input.organizationId);
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
             threshold=COALESCE($5,threshold), updated_at=now() WHERE id=$1 RETURNING *`,
          [board.id, input.name ?? null, chairId, input.quorum ?? null, input.threshold ?? null],
        )
      ).rows[0];
    }
    // Replace the membership set.
    await sql.query('DELETE FROM cab_board_members WHERE board_id=$1', [board.id]);
    for (const m of members) {
      await sql.query(
        `INSERT INTO cab_board_members (board_id, user_id, role, weight) VALUES ($1,$2,$3,$4)
         ON CONFLICT (board_id, user_id) DO UPDATE SET role=EXCLUDED.role, weight=EXCLUDED.weight`,
        [board.id, m.userId, m.role ?? (m.userId === chairId ? 'chair' : 'member'), m.weight ?? 1],
      );
    }
    await audit(actor, { action: 'cab.board.update', organizationId: org, resourceType: 'cab_board', resourceId: board.id, detail: { members: members.length, quorum: board.quorum, threshold: board.threshold } });
    return resolveBoard(sql, org);
  });
}

// ---- Blackout windows ----

export async function listBlackouts(actor: Principal, orgId?: string | null) {
  const org = targetOrg(actor, orgId);
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
  authorize(actor, 'cab.manage');
  const org = targetOrg(actor, input.organizationId);
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw Errors.badRequest('endsAt must be after startsAt');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const row = (
      await sql.query(
        `INSERT INTO change_blackouts (organization_id, name, starts_at, ends_at, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [org, input.name, input.startsAt, input.endsAt, input.reason ?? null, actor.id],
      )
    ).rows[0];
    await audit(actor, { action: 'cab.blackout.create', organizationId: org, resourceType: 'change_blackout', resourceId: row.id });
    return row;
  });
}

export async function deleteBlackout(actor: Principal, id: string) {
  authorize(actor, 'cab.manage');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    await sql.query('DELETE FROM change_blackouts WHERE id=$1', [id]);
    await audit(actor, { action: 'cab.blackout.delete', organizationId: actor.organizationId, resourceType: 'change_blackout', resourceId: id });
    return { deleted: true };
  });
}

// ---- Change templates ----

export async function listTemplates(actor: Principal, orgId?: string | null) {
  const org = targetOrg(actor, orgId);
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
  authorize(actor, 'cab.manage');
  const org = targetOrg(actor, input.organizationId);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const row = (
      await sql.query(
        `INSERT INTO change_templates
           (organization_id, name, change_type, risk, impact, likelihood, description, implementation_plan, test_plan, backout_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [org, input.name, input.changeType ?? 'standard', input.risk ?? 'low', input.impact ?? null, input.likelihood ?? null,
         input.description ?? null, input.implementationPlan ?? null, input.testPlan ?? null, input.backoutPlan ?? null],
      )
    ).rows[0];
    await audit(actor, { action: 'cab.template.create', organizationId: org, resourceType: 'change_template', resourceId: row.id });
    return row;
  });
}

export async function deleteTemplate(actor: Principal, id: string) {
  authorize(actor, 'cab.manage');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    await sql.query('DELETE FROM change_templates WHERE id=$1', [id]);
    await audit(actor, { action: 'cab.template.delete', organizationId: actor.organizationId, resourceType: 'change_template', resourceId: id });
    return { deleted: true };
  });
}

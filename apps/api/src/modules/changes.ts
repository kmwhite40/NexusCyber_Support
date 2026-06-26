// Change management + CAB (docs/nexus/03). Normal/emergency changes require multi-step
// CAB approval (reusing approvals + approval_steps); standard changes are pre-approved.
// A scheduled window feeds the change calendar and is checked for conflicts.
import { withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type ChangeType = 'standard' | 'normal' | 'emergency';
export type ChangeStatus = 'draft' | 'cab_review' | 'approved' | 'scheduled' | 'implementing' | 'review' | 'closed' | 'rejected';

const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ['cab_review', 'approved'], // standard changes skip CAB -> approved
  cab_review: ['approved', 'rejected'],
  approved: ['scheduled'],
  scheduled: ['implementing'],
  implementing: ['review'],
  review: ['closed'],
  closed: [],
  rejected: [],
};

/** Standard changes are pre-approved; normal & emergency need CAB. Pure. */
export function requiresCab(type: ChangeType): boolean {
  return type !== 'standard';
}

/** Is a change status transition allowed? Pure. */
export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface Windowed {
  id: string;
  window_start: string | Date | null;
  window_end: string | Date | null;
}

/** Return existing windows that overlap a candidate window. Pure. */
export function detectWindowConflicts(
  candidate: { start: Date; end: Date },
  existing: Windowed[],
  ignoreId?: string,
): Windowed[] {
  return existing.filter((e) => {
    if (e.id === ignoreId || !e.window_start || !e.window_end) return false;
    const s = new Date(e.window_start).getTime();
    const en = new Date(e.window_end).getTime();
    return s < candidate.end.getTime() && en > candidate.start.getTime();
  });
}

/** True once every CAB step has an approved decision. Pure. */
export function allStepsApproved(steps: Array<{ decision: string | null }>): boolean {
  return steps.length > 0 && steps.every((s) => s.decision === 'approved');
}

// ---- CAB quorum voting (dedicated subsystem; see spec 2026-06-25) ----

export type VoteValue = 'approve' | 'reject' | 'abstain';
export type Threshold = 'majority' | 'two_thirds' | 'unanimous';
export interface VoteRow { vote: VoteValue | null; weight: number }
export interface Tally { approve: number; reject: number; abstain: number; pending: number; cast: number; roster: number }

/** Weighted tally of a vote roster. Pure. */
export function tallyVotes(rows: VoteRow[]): Tally {
  const t: Tally = { approve: 0, reject: 0, abstain: 0, pending: 0, cast: 0, roster: 0 };
  for (const r of rows) {
    const w = r.weight ?? 1;
    t.roster += w;
    if (r.vote === 'approve') { t.approve += w; t.cast += w; }
    else if (r.vote === 'reject') { t.reject += w; t.cast += w; }
    else if (r.vote === 'abstain') { t.abstain += w; t.cast += w; }
    else t.pending += w;
  }
  return t;
}

/** Does the for/against split pass the threshold? `allVoted` = no pending roster left. Pure. */
function thresholdPasses(a: number, r: number, threshold: Threshold, allVoted: boolean): boolean {
  if (a + r === 0) return false;
  if (threshold === 'majority') return a > r;
  if (threshold === 'two_thirds') return a >= Math.ceil((2 * (a + r)) / 3);
  // unanimous: any reject fails; pass only once every non-abstaining voter has approved
  return r === 0 && allVoted;
}

/**
 * Resolve a change's CAB status from its vote roster. Pure.
 * Returns 'approved' | 'rejected' | 'cab_review' (still open).
 */
export function resolveVote(rows: VoteRow[], cfg: { quorum: number; threshold: Threshold }): ChangeStatus {
  const t = tallyVotes(rows);
  const quorumMet = t.cast >= cfg.quorum;
  const allVoted = t.pending === 0;
  if (quorumMet && thresholdPasses(t.approve, t.reject, cfg.threshold, allVoted)) return 'approved';
  // Reject once passing is mathematically impossible even if every pending vote approves.
  const canStillPass = thresholdPasses(t.approve + t.pending, t.reject, cfg.threshold, true);
  if (!canStillPass && t.approve + t.reject > 0) return 'rejected';
  if (quorumMet && allVoted && t.approve + t.reject === 0) return 'rejected'; // quorum met by all-abstain
  return 'cab_review';
}

const RISK_MATRIX: Record<string, Record<string, 'low' | 'medium' | 'high'>> = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'high' },
};
/** Impact x likelihood -> risk band. Pure. */
export function deriveRisk(impact: 'low' | 'medium' | 'high', likelihood: 'low' | 'medium' | 'high') {
  return RISK_MATRIX[impact][likelihood];
}

export interface CreateChangeInput {
  title: string;
  description?: string;
  changeType?: ChangeType;
  risk?: 'low' | 'medium' | 'high';
  ticketId?: string;
  backoutPlan?: string;
  organizationId?: string;
}

export async function createChange(actor: Principal, input: CreateChangeInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'change.create', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO changes (organization_id, ticket_id, title, description, change_type, risk, backout_plan, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, input.ticketId ?? null, input.title, input.description ?? null, input.changeType ?? 'normal', input.risk ?? 'medium', input.backoutPlan ?? null, actor.id],
    );
    const change = rows[0];
    await audit(actor, { action: 'change.create', organizationId: orgId, resourceType: 'change', resourceId: change.id, detail: { change_type: change.change_type } });
    publish('change.created', orgId, { change_id: change.id, change_type: change.change_type });
    return change;
  });
}

export async function listChanges(actor: Principal, filter: { status?: string } = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { params.push(filter.status); where.push(`status=$${params.length}`); }
    const { rows } = await sql.query(
      `SELECT * FROM changes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`,
      params,
    );
    return rows;
  });
}

async function loadSteps(sql: Sql, approvalId: string) {
  return (await sql.query('SELECT * FROM approval_steps WHERE approval_id=$1 ORDER BY step_order', [approvalId])).rows;
}

export async function getChange(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [id])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    const approval = (await sql.query("SELECT * FROM approvals WHERE subject_type='change' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
    const steps = approval ? await loadSteps(sql, approval.id) : [];
    return { ...change, approval, cab_steps: steps };
  });
}

/** Submit a change to the CAB: opens an approval with one step per board member. */
export async function submitForCab(actor: Principal, changeId: string, approverIds: string[]) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    authorize(actor, 'change.create', { organizationId: change.organization_id });
    if (change.status !== 'draft') throw Errors.conflict(`change is ${change.status}, not draft`);

    if (!requiresCab(change.change_type as ChangeType)) {
      // Standard change: pre-approved, no CAB.
      await sql.query("UPDATE changes SET status='approved', updated_at=now() WHERE id=$1", [changeId]);
      await audit(actor, { action: 'change.preapproved', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId });
      return { status: 'approved', cab: false };
    }
    if (!approverIds.length) throw Errors.badRequest('at least one CAB approver is required');

    const approval = (
      await sql.query(`INSERT INTO approvals (organization_id, subject_type, subject_id, status) VALUES ($1,'change',$2,'requested') RETURNING *`, [change.organization_id, changeId])
    ).rows[0];
    for (let i = 0; i < approverIds.length; i++) {
      await sql.query(
        `INSERT INTO approval_steps (organization_id, approval_id, step_order, approver_id) VALUES ($1,$2,$3,$4)`,
        [change.organization_id, approval.id, i, approverIds[i]],
      );
    }
    await sql.query("UPDATE changes SET status='cab_review', updated_at=now() WHERE id=$1", [changeId]);
    await audit(actor, { action: 'change.submit_cab', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { approvers: approverIds.length } });
    publish('change.cab_requested', change.organization_id, { change_id: changeId });
    return { status: 'cab_review', cab: true, steps: approverIds.length };
  });
}

/** Record the calling CAB member's decision; approve the change once every step approves. */
export async function cabDecision(actor: Principal, changeId: string, approve: boolean, reason?: string) {
  authorize(actor, 'change.approve');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    if (change.status !== 'cab_review') throw Errors.conflict(`change is ${change.status}, not in CAB review`);
    const approval = (await sql.query("SELECT * FROM approvals WHERE subject_type='change' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [changeId])).rows[0];
    if (!approval) throw Errors.notFound('no CAB approval found');
    const step = (await sql.query('SELECT * FROM approval_steps WHERE approval_id=$1 AND approver_id=$2', [approval.id, actor.id])).rows[0];
    if (!step) throw Errors.forbidden('you are not a CAB member for this change');
    if (step.decision) throw Errors.conflict('you have already decided');

    await sql.query('UPDATE approval_steps SET decision=$1, reason=$2, decided_at=now() WHERE id=$3', [approve ? 'approved' : 'rejected', reason ?? null, step.id]);

    if (!approve) {
      await sql.query("UPDATE approvals SET status='rejected' WHERE id=$1", [approval.id]);
      await sql.query("UPDATE changes SET status='rejected', updated_at=now() WHERE id=$1", [changeId]);
      await audit(actor, { action: 'change.cab_reject', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId });
      publish('change.rejected', change.organization_id, { change_id: changeId });
      return { status: 'rejected' };
    }

    const steps = await loadSteps(sql, approval.id);
    if (allStepsApproved(steps)) {
      await sql.query("UPDATE approvals SET status='approved' WHERE id=$1", [approval.id]);
      await sql.query("UPDATE changes SET status='approved', updated_at=now() WHERE id=$1", [changeId]);
      await audit(actor, { action: 'change.cab_approve', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { final: true } });
      publish('change.approved', change.organization_id, { change_id: changeId });
      return { status: 'approved' };
    }
    await audit(actor, { action: 'change.cab_approve', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { final: false } });
    return { status: 'cab_review', remaining: steps.filter((s) => !s.decision).length };
  });
}

/** Schedule an approved change into a window (checks the calendar for conflicts). */
export async function scheduleChange(actor: Principal, changeId: string, windowStart: string, windowEnd: string) {
  authorize(actor, 'change.implement');
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (end <= start) throw Errors.badRequest('window_end must be after window_start');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    if (change.status !== 'approved') throw Errors.conflict(`change must be approved to schedule (is ${change.status})`);
    const others = (await sql.query("SELECT id, window_start, window_end FROM changes WHERE status IN ('scheduled','implementing') AND organization_id=$1", [change.organization_id])).rows;
    const conflicts = detectWindowConflicts({ start, end }, others, changeId);
    await sql.query("UPDATE changes SET status='scheduled', window_start=$1, window_end=$2, updated_at=now() WHERE id=$3", [start.toISOString(), end.toISOString(), changeId]);
    await audit(actor, { action: 'change.schedule', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { conflicts: conflicts.length } });
    publish('change.scheduled', change.organization_id, { change_id: changeId, window_start: start.toISOString() });
    return { status: 'scheduled', conflicts: conflicts.map((c) => c.id) };
  });
}

/** Move a scheduled change through implementing -> review -> closed. */
export async function transitionChange(actor: Principal, changeId: string, to: ChangeStatus) {
  authorize(actor, 'change.implement');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    if (!canTransition(change.status as ChangeStatus, to)) throw Errors.conflict(`cannot move change from ${change.status} to ${to}`);
    await sql.query('UPDATE changes SET status=$1, updated_at=now() WHERE id=$2', [to, changeId]);
    await audit(actor, { action: `change.${to}`, organizationId: change.organization_id, resourceType: 'change', resourceId: changeId });
    return { status: to };
  });
}

/** Change calendar: scheduled/implementing changes overlapping a date range. */
export async function calendar(actor: Principal, from: string, to: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, title, change_type, risk, status, window_start, window_end
         FROM changes
        WHERE status IN ('scheduled','implementing')
          AND window_start < $2 AND window_end > $1
        ORDER BY window_start`,
      [from, to],
    );
    return rows;
  });
}

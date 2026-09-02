// Change management + CAB (docs/nexus/03). Normal/emergency changes go to a standing
// Change Advisory Board which VOTES (quorum + threshold); standard changes are pre-approved.
// Voting uses the dedicated cab_boards / change_votes subsystem (spec 2026-06-25) rather
// than the shared approvals/approval_steps tables that back elevation & automation.
// A scheduled window feeds the change calendar and is checked for conflicts.
import { withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import { resolveBoard } from './cab.js';
import type { Principal } from '../types.js';

export type ChangeType = 'standard' | 'normal' | 'emergency';
export type ChangeStatus =
  | 'draft' | 'cab_review' | 'approved' | 'scheduled' | 'implementing'
  | 'review' | 'closed' | 'rejected' | 'cancelled';

const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ['cab_review', 'approved', 'cancelled'], // standard changes skip CAB -> approved
  cab_review: ['approved', 'rejected', 'cancelled'],
  approved: ['scheduled', 'cancelled'],
  scheduled: ['implementing', 'cancelled'],
  implementing: ['review'],
  review: ['closed'],
  closed: [],
  rejected: [],
  cancelled: [],
};

/** Standard changes are pre-approved; normal & emergency need CAB. Pure. */
export function requiresCab(type: ChangeType): boolean {
  return type !== 'standard';
}

/** Is a change status transition allowed? Pure. */
export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * A post-implementation review is mandatory before a change may be closed, so
 * `review -> closed` is gated on `pir_outcome` being recorded. Pure.
 */
export function requiresPir(from: ChangeStatus, to: ChangeStatus): boolean {
  return from === 'review' && to === 'closed';
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

/** True once every CAB step has an approved decision. Pure.
 *  Legacy: the approvals/approval_steps CAB path predates quorum voting and is retained
 *  only so historical changes still render; new submissions use change_votes. */
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

/**
 * Add whole business days (Mon-Fri, UTC), preserving the time of day. Pure.
 * Deliberately calendar-only: the platform has no holiday table, and the vote deadline
 * only drives escalation, so weekday arithmetic is the honest approximation.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let remaining = Math.max(0, Math.trunc(days));
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d;
}

/** Vote deadline for a CAB submission: emergency = +4h, normal = +3 business days. Pure. */
export function voteDeadlineFor(type: ChangeType, from: Date): Date {
  if (type === 'emergency') return new Date(from.getTime() + 4 * 3600 * 1000);
  return addBusinessDays(from, 3);
}

/**
 * The emergency (ECAB) roster: the chair plus one other member. Pure.
 * Boards of two or fewer vote in full.
 */
export function ecabRoster<T extends { user_id: string }>(members: T[], chairId?: string | null): T[] {
  if (members.length <= 2) return [...members];
  const chair = members.find((m) => m.user_id === chairId) ?? members[0];
  const second = members.find((m) => m.user_id !== chair.user_id);
  return second ? [chair, second] : [chair];
}

/**
 * Quorum actually snapshotted onto a change. Clamped to the roster so a board whose
 * quorum exceeds the voters present (an ECAB cut, a shrunken board) cannot deadlock. Pure.
 */
export function snapshotQuorum(boardQuorum: number, rosterWeight: number): number {
  return Math.max(1, Math.min(Math.trunc(boardQuorum) || 1, rosterWeight));
}

export type VoteEligibility = 'ok' | 'not_a_voter' | 'not_open';

/**
 * May this actor cast a vote right now? Pure; the `change.vote` permission is checked
 * separately (both must hold). Membership is reported first: someone who was never on
 * the roster is told that, not that the vote closed.
 *
 * Re-voting: a member MAY change their vote while the change is still `cab_review`
 * (deliberation continues until the resolver finalizes). Once the resolver moves the
 * change out of `cab_review` the ballot is closed.
 */
export function voteEligibility(status: string, hasVoteRow: boolean): VoteEligibility {
  if (!hasVoteRow) return 'not_a_voter';
  if (status !== 'cab_review') return 'not_open';
  return 'ok';
}

export interface CreateChangeInput {
  title: string;
  description?: string;
  changeType?: ChangeType;
  risk?: 'low' | 'medium' | 'high';
  impact?: 'low' | 'medium' | 'high';
  likelihood?: 'low' | 'medium' | 'high';
  ticketId?: string;
  implementationPlan?: string;
  testPlan?: string;
  backoutPlan?: string;
  templateId?: string;
  organizationId?: string;
}

export async function createChange(actor: Principal, input: CreateChangeInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'change.create', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    // A template only supplies defaults; anything the caller passed wins.
    let tpl: Record<string, any> | undefined;
    if (input.templateId) {
      tpl = (
        await sql.query(
          'SELECT * FROM change_templates WHERE id=$1 AND (organization_id IS NULL OR organization_id=$2)',
          [input.templateId, orgId],
        )
      ).rows[0];
      if (!tpl) throw Errors.notFound('change template not found');
    }
    const changeType = (input.changeType ?? tpl?.change_type ?? 'normal') as ChangeType;
    const impact = input.impact ?? tpl?.impact ?? null;
    const likelihood = input.likelihood ?? tpl?.likelihood ?? null;
    const risk =
      input.risk ??
      (impact && likelihood ? deriveRisk(impact, likelihood) : (tpl?.risk ?? 'medium'));

    const { rows } = await sql.query(
      `INSERT INTO changes (organization_id, ticket_id, title, description, change_type, risk,
                            impact, likelihood, implementation_plan, test_plan, backout_plan, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        orgId, input.ticketId ?? null, input.title, input.description ?? tpl?.description ?? null,
        changeType, risk, impact, likelihood,
        input.implementationPlan ?? tpl?.implementation_plan ?? null,
        input.testPlan ?? tpl?.test_plan ?? null,
        input.backoutPlan ?? tpl?.backout_plan ?? null,
        actor.id,
      ],
    );
    const change = rows[0];
    await audit(actor, { action: 'change.create', organizationId: orgId, resourceType: 'change', resourceId: change.id, detail: { change_type: change.change_type, risk: change.risk, template_id: input.templateId ?? null } });
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

async function loadVotes(sql: Sql, changeId: string) {
  return (
    await sql.query(
      `SELECT id, voter_id, vote, reason, weight, ad_hoc, decided_at
         FROM change_votes WHERE change_id=$1 ORDER BY ad_hoc, created_at`,
      [changeId],
    )
  ).rows;
}

export async function getChange(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [id])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    // Legacy approvals-based CAB rows (pre-voting changes); empty for new submissions.
    const approval = (await sql.query("SELECT * FROM approvals WHERE subject_type='change' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
    const steps = approval ? await loadSteps(sql, approval.id) : [];
    const votes = await loadVotes(sql, id);
    return {
      ...change,
      approval,
      cab_steps: steps,
      votes,
      cab_tally: votes.length ? tallyVotes(votes.map((v: any) => ({ vote: v.vote, weight: v.weight }))) : null,
    };
  });
}

export interface SubmitForCabInput {
  /** Ad-hoc reviewers added to this change only (e.g. the app owner). */
  extraVoterIds?: string[];
  /** Override the board that governs this change; defaults to the org's standing board. */
  boardId?: string;
}

/**
 * Submit a change to the CAB: snapshots the voting roster into `change_votes` and the
 * board's quorum/threshold onto the change, so later board edits cannot retroactively
 * change an in-flight vote. Standard changes are pre-approved and skip the CAB.
 */
export async function submitForCab(actor: Principal, changeId: string, input: SubmitForCabInput = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    authorize(actor, 'change.create', { organizationId: change.organization_id });
    if (change.status !== 'draft') throw Errors.conflict(`change is ${change.status}, not draft`);

    if (!requiresCab(change.change_type as ChangeType)) {
      // Standard change: pre-approved, no CAB.
      await sql.query("UPDATE changes SET status='approved', updated_at=now() WHERE id=$1", [changeId]);
      await audit(actor, { action: 'change.preapproved', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId });
      return { status: 'approved' as const, cab: false };
    }

    const board = input.boardId
      ? (await sql.query('SELECT * FROM cab_boards WHERE id=$1', [input.boardId])).rows[0]
      : await resolveBoard(sql, change.organization_id);
    if (input.boardId && !board) throw Errors.notFound('CAB board not found');
    let members: Array<{ user_id: string; weight: number }> = board?.members
      ?? (input.boardId
        ? (await sql.query('SELECT user_id, weight FROM cab_board_members WHERE board_id=$1', [input.boardId])).rows
        : []);
    if (change.change_type === 'emergency') members = ecabRoster(members, board?.chair_id ?? null);

    // Standing roster first; ad-hoc reviewers are appended, de-duplicated against it
    // and against each other (one ballot per person — change_votes is unique per voter).
    const voters = members.map((m) => ({ user_id: m.user_id, weight: m.weight ?? 1, ad_hoc: false }));
    const seen = new Set(voters.map((v) => v.user_id));
    for (const id of input.extraVoterIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      voters.push({ user_id: id, weight: 1, ad_hoc: true });
    }
    if (!voters.length) {
      throw Errors.badRequest('no CAB voters: configure the board (PUT /api/v1/cab/board) or pass extraVoterIds');
    }

    const rosterWeight = voters.reduce((sum, v) => sum + v.weight, 0);
    const quorum = snapshotQuorum(board?.quorum ?? 1, rosterWeight);
    const threshold = (board?.threshold ?? 'majority') as Threshold;
    const deadline = voteDeadlineFor(change.change_type as ChangeType, new Date());

    for (const v of voters) {
      await sql.query(
        `INSERT INTO change_votes (organization_id, change_id, voter_id, weight, ad_hoc)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (change_id, voter_id) DO NOTHING`,
        [change.organization_id, changeId, v.user_id, v.weight, v.ad_hoc],
      );
    }
    await sql.query(
      `UPDATE changes SET status='cab_review', cab_board_id=$2, cab_quorum=$3, cab_threshold=$4,
              vote_deadline=$5, updated_at=now() WHERE id=$1`,
      [changeId, board?.id ?? null, quorum, threshold, deadline.toISOString()],
    );
    await audit(actor, { action: 'change.submit_cab', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { voters: voters.length, quorum, threshold, vote_deadline: deadline.toISOString() } });
    publish('change.cab_requested', change.organization_id, {
      change_id: changeId,
      voter_ids: voters.map((v) => v.user_id),
      vote_deadline: deadline.toISOString(),
    });
    return {
      status: 'cab_review' as const,
      cab: true,
      voters: voters.length,
      quorum,
      threshold,
      vote_deadline: deadline.toISOString(),
    };
  });
}

/**
 * Cast (or change) the calling board member's CAB vote and re-resolve the change.
 * Requires BOTH the `change.vote` permission AND a `change_votes` row for this change.
 */
export async function castVote(actor: Principal, changeId: string, vote: VoteValue, reason?: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    authorize(actor, 'change.vote', { organizationId: change.organization_id });

    const row = (await sql.query('SELECT * FROM change_votes WHERE change_id=$1 AND voter_id=$2', [changeId, actor.id])).rows[0];
    const eligibility = voteEligibility(change.status, !!row);
    if (eligibility === 'not_a_voter') throw Errors.forbidden('you are not a CAB voter for this change');
    if (eligibility === 'not_open') throw Errors.conflict(`change is ${change.status}, not in CAB review`);

    const changed = !!row.vote;
    await sql.query('UPDATE change_votes SET vote=$1, reason=$2, decided_at=now() WHERE id=$3', [vote, reason ?? null, row.id]);

    const rows = await loadVotes(sql, changeId);
    const cfg = { quorum: change.cab_quorum ?? 1, threshold: (change.cab_threshold ?? 'majority') as Threshold };
    const tally = tallyVotes(rows.map((r: any) => ({ vote: r.vote, weight: r.weight })));
    const outcome = resolveVote(rows.map((r: any) => ({ vote: r.vote, weight: r.weight })), cfg);

    await audit(actor, { action: 'change.vote', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { vote, changed, outcome, quorum: cfg.quorum, threshold: cfg.threshold } });
    publish('change.vote_cast', change.organization_id, { change_id: changeId, voter_id: actor.id, vote });

    if (outcome !== 'cab_review') {
      await sql.query('UPDATE changes SET status=$1, updated_at=now() WHERE id=$2', [outcome, changeId]);
      await audit(actor, { action: `change.cab_${outcome === 'approved' ? 'approve' : 'reject'}`, organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { final: true, tally } });
      publish(outcome === 'approved' ? 'change.approved' : 'change.rejected', change.organization_id, { change_id: changeId });
    }
    return { status: outcome, tally, quorum: cfg.quorum, threshold: cfg.threshold };
  });
}

/** Withdraw a change that has not been implemented yet. */
export async function cancelChange(actor: Principal, changeId: string, reason?: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    authorize(actor, 'change.create', { organizationId: change.organization_id });
    if (!canTransition(change.status as ChangeStatus, 'cancelled')) {
      throw Errors.conflict(`cannot cancel a change that is ${change.status}`);
    }
    await sql.query("UPDATE changes SET status='cancelled', updated_at=now() WHERE id=$1", [changeId]);
    await audit(actor, { action: 'change.cancel', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { from: change.status, reason: reason ?? null } });
    publish('change.cancelled', change.organization_id, { change_id: changeId });
    return { status: 'cancelled' as const };
  });
}

export type PirOutcome = 'successful' | 'failed' | 'rolled_back' | 'partial';

/** Record the post-implementation review; closes the change when it is in `review`. */
export async function recordPir(actor: Principal, changeId: string, outcome: PirOutcome, notes?: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    authorize(actor, 'change.implement', { organizationId: change.organization_id });
    if (change.status !== 'review' && change.status !== 'closed') {
      throw Errors.conflict(`change is ${change.status}; a PIR is recorded in review (or amended once closed)`);
    }
    const close = change.status === 'review';
    await sql.query(
      `UPDATE changes SET pir_outcome=$2, pir_notes=$3, pir_by=$4, pir_at=now(),
              status=CASE WHEN $5 THEN 'closed' ELSE status END, updated_at=now()
        WHERE id=$1`,
      [changeId, outcome, notes ?? null, actor.id, close],
    );
    await audit(actor, { action: 'change.pir', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { outcome, closed: close } });
    if (close) publish('change.closed', change.organization_id, { change_id: changeId, pir_outcome: outcome });
    return { status: close ? ('closed' as const) : (change.status as ChangeStatus), pir_outcome: outcome };
  });
}

// ---- Deliberation thread ----

export async function listComments(actor: Principal, changeId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT id FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    return (
      await sql.query(
        `SELECT c.id, c.change_id, c.author_id, u.display_name AS author_name, c.body, c.created_at
           FROM change_comments c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.change_id=$1 ORDER BY c.created_at`,
        [changeId],
      )
    ).rows;
  });
}

export async function addComment(actor: Principal, changeId: string, body: string) {
  const text = body.trim();
  if (!text) throw Errors.badRequest('comment body is required');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    // Deliberation is open to change raisers and to board voters.
    const org = { organizationId: change.organization_id };
    if (!can(actor, 'change.create', org) && !can(actor, 'change.vote', org)) {
      throw Errors.forbidden('missing change.create or change.vote');
    }
    const row = (
      await sql.query(
        `INSERT INTO change_comments (organization_id, change_id, author_id, body)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [change.organization_id, changeId, actor.id, text],
      )
    ).rows[0];
    await audit(actor, { action: 'change.comment', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId });
    publish('change.commented', change.organization_id, { change_id: changeId, comment_id: row.id });
    return row;
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
    const blackouts = detectWindowConflicts(
      { start, end },
      (
        await sql.query(
          `SELECT id, name, starts_at AS window_start, ends_at AS window_end FROM change_blackouts
            WHERE organization_id IS NULL OR organization_id=$1`,
          [change.organization_id],
        )
      ).rows,
    );
    await sql.query("UPDATE changes SET status='scheduled', window_start=$1, window_end=$2, updated_at=now() WHERE id=$3", [start.toISOString(), end.toISOString(), changeId]);
    await audit(actor, { action: 'change.schedule', organizationId: change.organization_id, resourceType: 'change', resourceId: changeId, detail: { conflicts: conflicts.length, blackouts: blackouts.length } });
    publish('change.scheduled', change.organization_id, { change_id: changeId, window_start: start.toISOString() });
    return {
      status: 'scheduled',
      conflicts: conflicts.map((c) => c.id),
      blackouts: blackouts.map((b: any) => ({ id: b.id, name: b.name })),
    };
  });
}

/** Move a scheduled change through implementing -> review -> closed. */
export async function transitionChange(actor: Principal, changeId: string, to: ChangeStatus) {
  authorize(actor, 'change.implement');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const change = (await sql.query('SELECT * FROM changes WHERE id=$1', [changeId])).rows[0];
    if (!change) throw Errors.notFound('change not found');
    if (!canTransition(change.status as ChangeStatus, to)) throw Errors.conflict(`cannot move change from ${change.status} to ${to}`);
    if (requiresPir(change.status as ChangeStatus, to) && !change.pir_outcome) {
      throw Errors.conflict('a post-implementation review is required before closing (POST /changes/:id/pir)');
    }
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

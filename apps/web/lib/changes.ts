// Typed browser client for change management + the CAB voting subsystem
// (apps/api/src/modules/changes.ts, cab.ts; routes in apps/api/src/http/routes.ts).
//
// ENVELOPE DISCIPLINE — read before adding a call. `apps/web/lib/api.ts` returns the
// parsed response body verbatim; it does NOT unwrap the `{ data: ... }` wrapper that
// the collection routes return. A generic like `api.get<Change[]>('/changes')`
// compiles but is simply wrong at runtime, and TypeScript cannot catch it because
// generics carry no runtime check (this exact mistake shipped once in the
// provisioning panel). So: every call here types the envelope honestly and unwraps
// with `.data` in this file, and components never see a wrapper. Which routes wrap is
// per-route and the only source of truth is routes.ts — the single-change reads and
// the lifecycle POSTs return their payload bare and are typed bare.
//
// ORG SCOPE — every /cab/* call takes a REQUIRED `organizationId`. Omitting it means
// GLOBAL on the API side, which is refused without the platform-wide `cab.manage.global`
// permission, so an omission would 403 for every ordinary org admin. Making the
// parameter non-optional is the type-level guard against that.
import { api } from '@/lib/api';

export type ChangeType = 'standard' | 'normal' | 'emergency';
export type ChangeStatus =
  | 'draft' | 'cab_review' | 'approved' | 'scheduled' | 'implementing'
  | 'review' | 'closed' | 'rejected' | 'cancelled';
export type RiskBand = 'low' | 'medium' | 'high';
export type Threshold = 'majority' | 'two_thirds' | 'unanimous';
export type VoteValue = 'approve' | 'reject' | 'abstain';
export type PirOutcome = 'successful' | 'failed' | 'rolled_back' | 'partial';
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'accent';

/** The row shape returned by GET /changes and GET /changes/calendar. */
export interface Change {
  id: string;
  title: string;
  change_type: ChangeType;
  risk: RiskBand;
  status: string;
  window_start: string | null;
  window_end: string | null;
}

/** Legacy approvals/approval_steps CAB row — pre-voting changes only. */
export interface CabStep { id: string; approver_id: string; decision: string | null; reason: string | null }

/** One ballot from `change_votes`. `vote === null` means the member has not voted yet. */
export interface ChangeVote {
  id: string;
  voter_id: string;
  vote: VoteValue | null;
  reason: string | null;
  weight: number;
  ad_hoc: boolean;
  decided_at: string | null;
}

export interface VoteTally {
  approve: number; reject: number; abstain: number;
  pending: number; cast: number; roster: number;
  /**
   * Cast/roster weight from STANDING board members only — the API measures quorum against
   * this, not `cast`, so ad-hoc reviewers cannot make a board quorate. Optional because a
   * change resolved before the field existed will not carry it; fall back to `cast`.
   */
  standing_cast?: number;
  standing_roster?: number;
}

/**
 * The bare `changes` row, as returned by POST /changes. It carries NO `votes`,
 * `cab_steps` or `cab_tally` — only `getChange` joins those on — so it is a separate
 * type from `ChangeRecord`. Typing a create as `ChangeRecord` would compile and then
 * throw the moment anything fed the result to the vote panel.
 */
export interface ChangeRow extends Change {
  organization_id: string;
  description: string | null;
  impact: RiskBand | null;
  likelihood: RiskBand | null;
  implementation_plan: string | null;
  test_plan: string | null;
  backout_plan: string | null;
  created_by: string | null;
  created_at: string;
  /**
   * The pre-approved template that authorised a `standard` (CAB-skipping) change. Null on
   * everything else — a standard change with null here was never pre-approved and the API
   * refuses to auto-approve it at submit.
   */
  standard_template_id?: string | null;
  cab_board_id: string | null;
  /** Effective quorum snapshotted at submit time. */
  cab_quorum: number | null;
  /**
   * What the board's configured quorum was at submit time, before clamping to the
   * eligible roster. Null on changes submitted before the column existed.
   */
  cab_quorum_requested: number | null;
  cab_threshold: Threshold | null;
  vote_deadline: string | null;
  pir_outcome: PirOutcome | null;
  pir_notes: string | null;
  pir_at: string | null;
}

/** GET /changes/:id — the `changes` row plus the CAB roster and tally joined on. */
export interface ChangeRecord extends ChangeRow {
  cab_steps: CabStep[];
  votes: ChangeVote[];
  cab_tally: VoteTally | null;
}

export interface ChangeComment {
  id: string;
  change_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface SubmitCabResult {
  status: 'cab_review' | 'approved';
  cab: boolean;
  voters?: number;
  quorum?: number;
  quorum_requested?: number;
  quorum_clamped?: boolean;
  threshold?: Threshold;
  vote_deadline?: string;
}

export interface VoteResult { status: ChangeStatus; tally: VoteTally; quorum: number; threshold: Threshold }
export interface ScheduleResult { status: string; conflicts: string[]; blackouts: Array<{ id: string; name: string }> }

export interface CabBoardMember { user_id: string; role: 'chair' | 'member'; weight: number }
/** What PUT /cab/board expects per member. `weight` must be round-tripped: putBoard
 *  deletes and re-inserts the whole membership set, defaulting anything omitted to 1. */
export interface CabBoardMemberInput { userId: string; role?: 'chair' | 'member'; weight?: number }
export interface CabBoard {
  id?: string;
  organization_id: string | null;
  name: string;
  chair_id?: string | null;
  quorum: number;
  threshold: Threshold;
  members: CabBoardMember[];
}
export interface Blackout {
  id: string;
  organization_id: string | null;
  name: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}
export interface ChangeTemplate {
  id: string;
  organization_id: string | null;
  name: string;
  change_type: ChangeType;
  risk: RiskBand;
  impact: RiskBand | null;
  likelihood: RiskBand | null;
  description: string | null;
  implementation_plan: string | null;
  test_plan: string | null;
  backout_plan: string | null;
}

// ---- Pure presentation helpers (unit-testable, no React) ----

export const statusTone = (s: string): BadgeTone =>
  s === 'approved' || s === 'closed' ? 'success'
    : s === 'rejected' ? 'danger'
    : s === 'cab_review' ? 'warning'
    : 'neutral';

export const riskTone = (r: string): BadgeTone =>
  r === 'high' ? 'danger' : r === 'medium' ? 'warning' : 'neutral';

/**
 * How the server will actually apply the threshold, stated in full.
 *
 * `unanimous` is not "unanimous of the votes cast": `thresholdPasses` additionally requires
 * that NOTHING is still pending, so a board that is unanimous so far but has an outstanding
 * ballot stays in `cab_review`. Saying "unanimous of votes cast" told members the vote was
 * decided while the server was still holding it open.
 */
export const THRESHOLD_RULE: Record<Threshold, string> = {
  majority: 'simple majority of votes cast',
  two_thirds: 'two-thirds of votes cast',
  unanimous: 'unanimous — and every ballot must be cast',
};

export interface QuorumProgress {
  /** Weight already cast (approve + reject + abstain). */
  cast: number;
  /** Effective quorum this vote runs at. */
  quorum: number;
  /** Still needed to reach quorum; 0 once met. */
  remaining: number;
  met: boolean;
  /** 0-100, for the progress bar. */
  pct: number;
}

/**
 * Quorum progress for the tally bar. Pure. Mirrors resolveVote's
 * `standing_cast >= quorum` — ad-hoc ballots do not count toward quorum on the server, so
 * showing them here would overstate how close the board is to being quorate.
 */
export function quorumProgress(tally: VoteTally | null, quorum: number | null): QuorumProgress {
  const q = Math.max(1, quorum ?? 1);
  const cast = tally?.standing_cast ?? tally?.cast ?? 0;
  return {
    cast,
    quorum: q,
    remaining: Math.max(0, q - cast),
    met: cast >= q,
    pct: Math.min(100, Math.round((cast / q) * 100)),
  };
}

/**
 * Was this change's quorum weakened below what the board configured? Pure.
 *
 * The API clamps a board's quorum down to the eligible roster so a board that has
 * shrunk (an ECAB cut, a recused raiser, departed members) cannot deadlock in
 * `cab_review` forever — but that clamp WEAKENS the board's own rule, so the people
 * voting are entitled to see it. Returns null when nothing was clamped, or when the
 * change predates the `cab_quorum_requested` column.
 */
export function quorumClamp(
  change: Pick<ChangeRecord, 'cab_quorum' | 'cab_quorum_requested'>,
): { effective: number; requested: number } | null {
  const effective = change.cab_quorum;
  const requested = change.cab_quorum_requested;
  if (effective == null || requested == null) return null;
  if (requested <= effective) return null;
  return { effective, requested };
}

export type VoteOutcome = 'approved' | 'rejected' | 'open';
export interface VoteOutlook {
  /** What the server's resolver would decide on this tally right now. */
  outcome: VoteOutcome;
  quorumMet: boolean;
  /** While `open`, the one thing still missing — in the panel's own words. */
  blocker: string | null;
}

/** Mirror of the API's private `thresholdPasses` (apps/api/src/modules/changes.ts). */
function thresholdPasses(a: number, r: number, threshold: Threshold, allVoted: boolean): boolean {
  if (a + r === 0) return false;
  if (threshold === 'majority') return a > r;
  if (threshold === 'two_thirds') return a >= Math.ceil((2 * (a + r)) / 3);
  return r === 0 && allVoted;
}

/**
 * What would `resolveVote` decide on this tally right now, and if nothing yet, why? Pure.
 *
 * This exists because the panel must never claim an outcome the server would not reach.
 * "Quorum met" plus "unanimous of votes cast" read as decided, while the server was still
 * holding the change in `cab_review` waiting on a pending ballot. Deliberately a mirror of
 * the API resolver rather than an approximation of it: same quorum source (standing cast
 * only), same threshold rules, same abstain handling.
 */
export function voteOutlook(
  tally: VoteTally | null,
  quorum: number | null,
  threshold: Threshold,
): VoteOutlook {
  const q = Math.max(1, quorum ?? 1);
  const approve = tally?.approve ?? 0;
  const reject = tally?.reject ?? 0;
  const pending = tally?.pending ?? 0;
  const quorumMet = (tally?.standing_cast ?? tally?.cast ?? 0) >= q;
  const allVoted = pending === 0;

  if (quorumMet && thresholdPasses(approve, reject, threshold, allVoted)) {
    return { outcome: 'approved', quorumMet, blocker: null };
  }
  const canStillPass = thresholdPasses(approve + pending, reject, threshold, true);
  if (!canStillPass && approve + reject > 0) return { outcome: 'rejected', quorumMet, blocker: null };
  if (quorumMet && allVoted && approve + reject === 0) return { outcome: 'rejected', quorumMet, blocker: null };

  const blocker = !quorumMet
    ? 'quorum not met'
    : approve + reject === 0
      ? 'no votes for or against yet'
      : threshold === 'unanimous' && pending > 0
        ? `awaiting ${pending} more ballot${pending === 1 ? '' : 's'}`
        : threshold === 'two_thirds'
          ? 'approvals are short of two-thirds'
          : 'approvals do not yet outweigh rejections';
  return { outcome: 'open', quorumMet, blocker };
}

/**
 * Is `userId` the raiser of this change, and therefore recused? Pure.
 *
 * The raiser never gets a `change_votes` row (segregation of duties, enforced at
 * roster construction in the API), so without this the roster just looks short one
 * person. Surfacing the recusal explicitly is the difference between "the board is
 * two people" and "the board is three people, one of whom raised this".
 */
export function isRecusedRaiser(change: Pick<ChangeRecord, 'created_by'>, userId: string | null | undefined): boolean {
  return !!userId && !!change.created_by && change.created_by === userId;
}

/**
 * This user's ballot on this change, cast or not — null if they hold none. Pure.
 * Callers decide what to do with a ballot that already has a vote on it.
 */
export function ballotFor(votes: ChangeVote[], userId: string | null | undefined): ChangeVote | null {
  if (!userId) return null;
  return votes.find((v) => v.voter_id === userId) ?? null;
}

/**
 * Does any ballot on this roster carry a weight other than 1? Pure.
 *
 * Matters for wording, not arithmetic: `tallyVotes` sums WEIGHT, so `roster`, `cast`,
 * `pending` and the quorum are weight units, not head counts. On an unweighted board the
 * two coincide and plain "votes" reads best; on a weighted board they diverge and the
 * numbers would not reconcile with the rows on screen unless the units are named.
 */
export function isWeightedRoster(votes: Array<{ weight: number }>): boolean {
  return votes.some((v) => (v.weight ?? 1) !== 1);
}

// ---- API ----

export const changesApi = {
  list: (status?: string) =>
    api.get<{ data: Change[] }>(`/changes${status ? `?status=${encodeURIComponent(status)}` : ''}`).then((r) => r.data),
  calendar: (from: string, to: string) =>
    api
      .get<{ data: Change[] }>(`/changes/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => r.data),
  // Bare: routes.ts returns getChange(...) directly, with no { data } wrapper.
  get: (id: string) => api.get<ChangeRecord>(`/changes/${id}`),
  create: (body: {
    title: string; description?: string; changeType?: string; risk?: string;
    impact?: string; likelihood?: string; implementationPlan?: string; testPlan?: string;
    backoutPlan?: string; templateId?: string; organizationId?: string;
  }) => api.post<ChangeRow>('/changes', body),
  submitCab: (id: string, body: { extraVoterIds?: string[]; boardId?: string } = {}) =>
    api.post<SubmitCabResult>(`/changes/${id}/submit-cab`, body),
  vote: (id: string, vote: VoteValue, reason?: string) =>
    api.post<VoteResult>(`/changes/${id}/vote`, reason ? { vote, reason } : { vote }),
  cancel: (id: string, reason?: string) =>
    api.post<{ status: 'cancelled' }>(`/changes/${id}/cancel`, reason ? { reason } : {}),
  pir: (id: string, outcome: PirOutcome, notes?: string) =>
    api.post<{ status: string; pir_outcome: PirOutcome }>(`/changes/${id}/pir`, notes ? { outcome, notes } : { outcome }),
  schedule: (id: string, windowStart: string, windowEnd: string) =>
    api.post<ScheduleResult>(`/changes/${id}/schedule`, { windowStart, windowEnd }),
  transition: (id: string, to: 'implementing' | 'review' | 'closed') =>
    api.post<{ status: string }>(`/changes/${id}/transition`, { to }),
  // Pre-approved standard templates a raiser may build from (change.create, not cab.manage).
  templates: (organizationId?: string) =>
    api
      .get<{ data: ChangeTemplate[] }>(
        `/changes/templates${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`,
      )
      .then((r) => r.data),
  comments: (id: string) => api.get<{ data: ChangeComment[] }>(`/changes/${id}/comments`).then((r) => r.data),
  addComment: (id: string, body: string) => api.post<ChangeComment>(`/changes/${id}/comments`, { body }),
};

/**
 * CAB administration. `organizationId` is required on every call — see the ORG SCOPE
 * note at the top of this file.
 */
export const cabApi = {
  board: (organizationId: string) =>
    api.get<{ data: CabBoard }>(`/cab/board?organizationId=${encodeURIComponent(organizationId)}`).then((r) => r.data),
  saveBoard: (input: {
    organizationId: string;
    name?: string;
    chairId?: string | null;
    quorum?: number;
    threshold?: Threshold;
    members?: CabBoardMemberInput[];
  }) => api.put<{ data: CabBoard }>('/cab/board', input).then((r) => r.data),

  blackouts: (organizationId: string) =>
    api
      .get<{ data: Blackout[] }>(`/cab/blackouts?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.data),
  createBlackout: (input: {
    organizationId: string; name: string; startsAt: string; endsAt: string; reason?: string;
  }) => api.post<Blackout>('/cab/blackouts', input),
  deleteBlackout: (id: string) => api.del<{ deleted: boolean }>(`/cab/blackouts/${id}`),

  templates: (organizationId: string) =>
    api
      .get<{ data: ChangeTemplate[] }>(`/cab/templates?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.data),
  createTemplate: (input: {
    organizationId: string; name: string; changeType?: ChangeType; risk?: RiskBand;
    impact?: RiskBand; likelihood?: RiskBand; description?: string;
    implementationPlan?: string; testPlan?: string; backoutPlan?: string;
  }) => api.post<ChangeTemplate>('/cab/templates', input),
  deleteTemplate: (id: string) => api.del<{ deleted: boolean }>(`/cab/templates/${id}`),
};

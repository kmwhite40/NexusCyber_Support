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
}

/** GET /changes/:id — the whole `changes` row plus the CAB roster and tally. */
export interface ChangeRecord extends Change {
  organization_id: string;
  description: string | null;
  impact: RiskBand | null;
  likelihood: RiskBand | null;
  implementation_plan: string | null;
  test_plan: string | null;
  backout_plan: string | null;
  created_by: string | null;
  created_at: string;
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

export const THRESHOLD_LABEL: Record<Threshold, string> = {
  majority: 'simple majority',
  two_thirds: 'two-thirds',
  unanimous: 'unanimous',
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

/** Quorum progress for the tally bar. Pure. Mirrors resolveVote's `cast >= quorum`. */
export function quorumProgress(tally: VoteTally | null, quorum: number | null): QuorumProgress {
  const q = Math.max(1, quorum ?? 1);
  const cast = tally?.cast ?? 0;
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

/** Does this user hold an uncast ballot on this change? Pure — drives the vote buttons. */
export function pendingBallotFor(votes: ChangeVote[], userId: string | null | undefined): ChangeVote | null {
  if (!userId) return null;
  return votes.find((v) => v.voter_id === userId) ?? null;
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
  }) => api.post<ChangeRecord>('/changes', body),
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
    members?: Array<{ userId: string; role?: 'chair' | 'member'; weight?: number }>;
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

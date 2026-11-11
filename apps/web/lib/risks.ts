// Typed browser client for the risk register (apps/api/src/http/routes-risks.ts).
//
// ENVELOPE DISCIPLINE (see lib/changes.ts): collection routes answer `{ data: [...] }` and are
// unwrapped HERE; single-record reads and writes answer bare. Components never see a wrapper.
//
// ORG SCOPE: staff must name the organization on every register call. Customer callers pass
// undefined and the API uses their own organization.
import { api, API_BASE, getToken, ApiError } from '@/lib/api';

export type RiskStatus = 'identified' | 'assessed' | 'treating' | 'monitoring' | 'accepted' | 'closed';
export type RiskRating = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
export type AppetiteState = 'within' | 'above_appetite' | 'above_tolerance';
export type Strategy = 'mitigate' | 'transfer' | 'avoid' | 'accept';
export type LinkKind = 'control' | 'finding' | 'ticket' | 'problem' | 'change' | 'service';
export type HeatmapBasis = 'inherent' | 'residual' | 'target';

export const CATEGORIES = [
  'cybersecurity', 'privacy', 'operational', 'compliance', 'third_party',
  'technology', 'financial', 'strategic', 'reputational', 'physical',
] as const;
export type RiskCategory = (typeof CATEGORIES)[number];

export const IMPACT_DIMENSIONS = [
  'confidentiality', 'integrity', 'availability', 'financial',
  'operational', 'reputational', 'compliance', 'safety',
] as const;

export const LIKELIHOOD_LABELS = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'] as const;
export const IMPACT_LABELS = ['Negligible', 'Minor', 'Moderate', 'Major', 'Severe'] as const;
export const STATUSES: RiskStatus[] = ['identified', 'assessed', 'treating', 'monitoring', 'accepted', 'closed'];

export const RATING_LABEL: Record<RiskRating, string> = {
  very_low: 'Very low', low: 'Low', moderate: 'Moderate', high: 'High', very_high: 'Very high',
};

/** Mirrors risk-scoring.ts rating(): kept in step by test/risks-lib.test.ts. */
export function ratingFor(score: number): RiskRating {
  if (score >= 20) return 'very_high';
  if (score >= 15) return 'high';
  if (score >= 8) return 'moderate';
  if (score >= 4) return 'low';
  return 'very_low';
}

/**
 * Heat-map cell fill per rating. A 5-step ramp from the theme's success to danger tokens, so it
 * follows light/dark mode; text on every step stays legible because the fill is translucent.
 */
export const RATING_FILL: Record<RiskRating, string> = {
  very_low: 'hsl(var(--success) / 0.22)',
  low: 'hsl(var(--success) / 0.45)',
  moderate: 'hsl(var(--warning) / 0.38)',
  high: 'hsl(var(--warning) / 0.7)',
  very_high: 'hsl(var(--danger) / 0.75)',
};
export const RATING_TONE: Record<RiskRating, 'success' | 'warning' | 'danger' | 'neutral'> = {
  very_low: 'neutral', low: 'success', moderate: 'warning', high: 'danger', very_high: 'danger',
};

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

export interface UserRef { id: string; name: string | null }
export interface FairRange { min: number; likely: number; max: number }
export interface FairInputs { lef: FairRange; lm: FairRange }
export interface FairResults { mean: number; p10: number; p50: number; p90: number; p95: number; iterations: number; seed: number }

export interface Risk {
  id: string;
  organization_id: string;
  risk_number: number;
  ref: string;
  title: string;
  description: string | null;
  cause: string | null;
  event: string | null;
  consequence: string | null;
  category: RiskCategory;
  threat_source: string | null;
  status: RiskStatus;
  strategy: Strategy | null;
  owner_id: string | null;
  owner_name: string | null;
  owner: UserRef | null;
  inherent_likelihood: number; inherent_impact: number; inherent_score: number;
  residual_likelihood: number; residual_impact: number; residual_score: number;
  target_likelihood: number | null; target_impact: number | null; target_score: number | null;
  inherent_rating: RiskRating; residual_rating: RiskRating; target_rating: RiskRating | null;
  impact_dimensions: Record<string, number>;
  velocity: string | null;
  fair_inputs: FairInputs | null;
  fair_results: FairResults | null;
  review_frequency_days: number | null;
  last_reviewed_at: string;
  next_review_at: string;
  review_overdue: boolean;
  appetite_state: AppetiteState;
  acceptance_status: 'none' | 'requested' | 'approved' | 'rejected';
  acceptance_justification: string | null;
  acceptance_expires_at: string | null;
  acceptance_requested_by: string | null;
  acceptance_active: boolean;
  tags: string[];
  treatment_progress: number | null;
  treatment_count?: number;
  treatments_overdue?: number;
  link_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Treatment {
  id: string; title: string; description: string | null; status: 'planned' | 'in_progress' | 'done' | 'cancelled';
  due_at: string | null; completed_at: string | null; cost_estimate: string | number | null; ticket_id: string | null;
  owner: UserRef | null;
}
export interface RiskLink { id: string; kind: LinkKind; ref: string; label: string | null; created_at: string }
export interface HistoryEntry {
  id: string; kind: string; inherent_score: number | null; residual_score: number | null; target_score: number | null;
  status: string | null; ale_p50: string | number | null; note: string | null; actor: UserRef | null; created_at: string;
}
export interface RiskSettings { organization_id: string; appetite_score: number; tolerance_score: number; max_acceptance_days: number; is_default: boolean }

export interface RiskDetail extends Risk {
  settings: RiskSettings;
  treatments: Treatment[];
  links: RiskLink[];
  history: HistoryEntry[];
  treatments_overdue: number;
  acceptance_requested_by_user: UserRef | null;
  acceptance_decided_by_user: UserRef | null;
}

export interface PortfolioRow {
  organization_id: string;
  organization_name: string;
  open: number;
  by_rating: Record<RiskRating, number>;
  above_appetite: number;
  above_tolerance: number;
  overdue_reviews: number;
  worst_residual: number | null;
  ale_p50: number | null;
  ale_p90: number | null;
  quantified: number;
  appetite_score: number;
  tolerance_score: number;
}

export interface FindingCandidate { id: string; title: string; domain: string; severity: string; status: string }

/** Body for create/update. Mirrors the zod schema in routes-risks.ts (camelCase). */
export interface RiskWrite {
  organizationId?: string;
  title?: string;
  description?: string | null;
  cause?: string | null;
  event?: string | null;
  consequence?: string | null;
  category?: RiskCategory;
  threatSource?: string | null;
  strategy?: Strategy | null;
  ownerName?: string | null;
  inherentLikelihood?: number;
  inherentImpact?: number;
  residualLikelihood?: number;
  residualImpact?: number;
  targetLikelihood?: number | null;
  targetImpact?: number | null;
  impactDimensions?: Record<string, number>;
  velocity?: string | null;
  fair?: FairInputs | null;
  reviewFrequencyDays?: number | null;
  tags?: string[];
  note?: string;
}

function qs(params: Record<string, string | undefined | boolean>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export interface ListParams { status?: string; category?: string; rating?: string; q?: string; includeClosed?: boolean }

export const risksApi = {
  portfolio: async () => (await api.get<{ data: PortfolioRow[] }>('/risks/portfolio')).data,
  list: async (organizationId: string | undefined, p: ListParams = {}) =>
    (await api.get<{ data: Risk[] }>(`/risks${qs({ organizationId, ...p })}`)).data,
  get: (id: string) => api.get<RiskDetail>(`/risks/${id}`),
  create: (body: RiskWrite) => api.post<Risk>('/risks', body),
  update: (id: string, body: RiskWrite) => api.patch<Risk>(`/risks/${id}`, body),
  review: (id: string, note?: string) => api.post<Risk>(`/risks/${id}/review`, note ? { note } : {}),
  transition: (id: string, to: RiskStatus, note?: string) => api.post<Risk>(`/risks/${id}/transition`, { to, note }),
  requestAcceptance: (id: string, justification: string, expiresAt: string) =>
    api.post<Risk>(`/risks/${id}/acceptance`, { justification, expiresAt }),
  decideAcceptance: (id: string, approve: boolean, note?: string) =>
    api.post<Risk>(`/risks/${id}/acceptance/decide`, { approve, note }),
  addTreatment: (id: string, body: { title: string; dueAt?: string | null; status?: Treatment['status'] }) =>
    api.post<Treatment>(`/risks/${id}/treatments`, body),
  updateTreatment: (id: string, tid: string, body: Partial<{ title: string; status: Treatment['status']; dueAt: string | null }>) =>
    api.patch<Treatment>(`/risks/${id}/treatments/${tid}`, body),
  addLink: (id: string, kind: LinkKind, ref: string) => api.post<RiskLink>(`/risks/${id}/links`, { kind, ref }),
  removeLink: (id: string, linkId: string) => api.del<{ ok: true }>(`/risks/${id}/links/${linkId}`),
  settings: (organizationId: string | undefined) => api.get<RiskSettings>(`/risks/settings${qs({ organizationId })}`),
  putSettings: (organizationId: string | undefined, body: { appetiteScore: number; toleranceScore: number; maxAcceptanceDays?: number }) =>
    api.put<RiskSettings>(`/risks/settings${qs({ organizationId })}`, body),
  findingCandidates: async (organizationId: string | undefined) =>
    (await api.get<{ data: FindingCandidate[] }>(`/risks/finding-candidates${qs({ organizationId })}`)).data,
  fromFinding: (findingId: string) => api.post<Risk>(`/risks/from-finding/${findingId}`),

  /** Fetch the CSV with the bearer token and hand it to the browser as a download. */
  async exportCsv(organizationId: string | undefined): Promise<void> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/risks/export.csv${qs({ organizationId })}`, { headers, credentials: 'include' });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `risk-register-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/** 5x5 counts [likelihood-1][impact-1], mirroring risk-scoring.ts heatmap(). */
export function heatmap(risks: Risk[], basis: HeatmapBasis): number[][] {
  const g = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  for (const r of risks) {
    if (r.status === 'closed') continue;
    const l = basis === 'inherent' ? r.inherent_likelihood : basis === 'residual' ? r.residual_likelihood : r.target_likelihood;
    const i = basis === 'inherent' ? r.inherent_impact : basis === 'residual' ? r.residual_impact : r.target_impact;
    if (!l || !i) continue;
    g[l - 1][i - 1]++;
  }
  return g;
}

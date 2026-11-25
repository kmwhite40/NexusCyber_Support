// Typed browser client for the risk register (apps/api/src/http/routes-risks.ts).
//
// ENVELOPE DISCIPLINE (see lib/changes.ts): collection routes answer `{ data: [...] }` and are
// unwrapped HERE; single-record reads and writes answer bare. Components never see a wrapper.
//
// ORG SCOPE: staff must name the organization on every register call. Customer callers pass
// undefined and the API uses their own organization.
import { api, API_BASE, getToken, ApiError } from '@/lib/api';

export type RiskStatus = 'identified' | 'assessed' | 'treating' | 'monitoring' | 'accepted' | 'closed';
export type RiskRating = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high' | 'critical';
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

/** The ACTIVE methodology's ratings, worst first (nexus-5x5@2). Older risks may still carry 'very_low' (v1). */
export const RATINGS_ORDER: readonly RiskRating[] = ['critical', 'very_high', 'high', 'moderate', 'low'];
export const RATING_LABEL: Record<RiskRating, string> = {
  very_low: 'Very low', low: 'Low', moderate: 'Moderate', high: 'High', very_high: 'Very high', critical: 'Critical',
};

/**
 * PREVIEW banding with the active methodology (nexus-5x5@2: 1-4 Low, 5-9 Moderate, 10-14 High,
 * 15-19 Very High, 20-25 Critical), for heat-map cells and score previews. A saved risk's rating
 * comes from the API, which bands it with the methodology that scored it. Kept in step with
 * risk-scoring.ts by test/risks-page.test.tsx.
 */
export function ratingFor(score: number): RiskRating {
  if (score >= 20) return 'critical';
  if (score >= 15) return 'very_high';
  if (score >= 10) return 'high';
  if (score >= 5) return 'moderate';
  return 'low';
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
  very_high: 'hsl(var(--danger) / 0.6)',
  critical: 'hsl(var(--danger) / 0.9)',
};
export const RATING_TONE: Record<RiskRating, 'success' | 'warning' | 'danger' | 'neutral'> = {
  very_low: 'neutral', low: 'success', moderate: 'warning', high: 'danger', very_high: 'danger', critical: 'danger',
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
  /** The scoring methodology version that produced the ratings above. */
  methodology?: { key: string; version: number; name: string };
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

export type PackageDecision = 'accepted' | 'not_accepted' | 'not_marked';

/** Mirrors PackageSummary in apps/api/src/modules/acceptance-packages.ts. */
export interface AcceptancePackage {
  id: string;
  organization_id: string;
  number: string;
  reference: string | null;
  status: string;
  risk_ids: string[];
  sha256: string;
  generated_at: string;
  generated_by: string | null;
  signed_by_name: string | null;
  signed_by_title: string | null;
  /** YYYY-MM-DD */
  signed_on: string | null;
  recorded_at: string | null;
  signed_attachment_id: string | null;
  decisions: unknown;
}

export interface RecordPackagePayload {
  signedByName: string;
  signedByTitle: string;
  signedOn: string;
  decisions: Record<string, PackageDecision>;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function failFrom(res: Response): Promise<ApiError> {
  let detail = res.statusText;
  try { const j = JSON.parse(await res.text()); detail = j?.detail ?? j?.title ?? detail; } catch { /* not JSON */ }
  return new ApiError(res.status, detail);
}

function qs(params: Record<string, string | undefined | boolean>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export interface ListParams { status?: string; category?: string; rating?: string; q?: string; includeClosed?: boolean }

/** One week of an organization's open risks (GET /risks/trend). Totals are sums of ordinal L×I
 *  scores: an exposure indicator, never a loss estimate. */
export interface TrendPoint {
  week: string;
  open: number;
  inherent_total: number;
  residual_total: number;
  target_total: number | null;
  by_inherent_rating: Record<RiskRating, number>;
}

export const risksApi = {
  trend: async (organizationId: string | undefined, weeks = 12) =>
    (await api.get<{ points: TrendPoint[] }>(`/risks/trend${qs({ organizationId, weeks: String(weeks) })}`)).points,
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

  packages: async (organizationId: string | undefined) =>
    (await api.get<{ data: AcceptancePackage[] }>(`/risks/acceptance-packages${qs({ organizationId })}`)).data,
  issuePackage: (organizationId: string | undefined, riskIds: string[], reference: string) =>
    api.post<AcceptancePackage>('/risks/acceptance-packages', {
      organizationId,
      riskIds,
      reference: reference.trim() || undefined,
    }),
  voidPackage: (id: string, reason: string) => api.post<AcceptancePackage>(`/risks/acceptance-packages/${id}/void`, { reason }),
  /** Multipart: the signed copy in `file`, the AO's details and per-risk decisions as JSON in `payload`. */
  async recordPackage(id: string, payload: RecordPackagePayload, file: File): Promise<AcceptancePackage> {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    form.append('file', file);
    const res = await fetch(`${API_BASE}/risks/acceptance-packages/${id}/record`, { method: 'POST', headers: authHeaders(), body: form });
    if (!res.ok) throw await failFrom(res);
    return (await res.json()) as AcceptancePackage;
  },
  /**
   * Open the stored print HTML in a new tab. The tab is opened FIRST, synchronously, so it counts as
   * part of the user's click (a window opened after an await is treated as a pop-up and blocked).
   */
  async openPackage(id: string): Promise<void> {
    const win = window.open('', '_blank');
    if (!win) throw new ApiError(0, 'Allow pop-ups for Anchor to print the package');
    try {
      const res = await fetch(`${API_BASE}/risks/acceptance-packages/${id}/html`, { headers: authHeaders() });
      if (!res.ok) throw await failFrom(res);
      const html = await res.text();
      win.document.open();
      win.document.write(html);
      win.document.close();
    } catch (e) {
      win.close();
      throw e;
    }
  },

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

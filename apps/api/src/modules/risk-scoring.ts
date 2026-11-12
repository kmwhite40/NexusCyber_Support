// Risk register scoring — every rule the register applies, as pure functions.
//
// Nothing here touches the database, so each rule is unit-tested directly (test/risk-scoring.test.ts)
// and the module (risks.ts) stays a thin layer of authorization, SQL and audit around it.
//
// Sources the rules are drawn from:
//   NIST SP 800-30 r1 App. G-I  — 5-level likelihood & impact, semi-quantitative 1-25 matrix
//   FIPS 199                    — high-water mark across impact dimensions
//   ISO 31000 / NIST SP 800-39  — treatment strategies, appetite vs. tolerance
//   FAIR (Open Group O-RA)      — ALE = loss-event frequency x loss magnitude, PERT ranges, Monte Carlo
//   COSO ERM                    — velocity
//   FedRAMP ConMon / POA&M      — time-boxed acceptance, review cadence by rating

export const LIKELIHOOD_LABELS = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'] as const;
export const IMPACT_LABELS = ['Negligible', 'Minor', 'Moderate', 'Major', 'Severe'] as const;

export const CATEGORIES = [
  'cybersecurity', 'privacy', 'operational', 'compliance', 'third_party',
  'technology', 'financial', 'strategic', 'reputational', 'physical',
] as const;
export type RiskCategory = (typeof CATEGORIES)[number];

export const IMPACT_DIMENSIONS = [
  'confidentiality', 'integrity', 'availability', 'financial',
  'operational', 'reputational', 'compliance', 'safety',
] as const;
export type ImpactDimension = (typeof IMPACT_DIMENSIONS)[number];

export type RiskStatus = 'identified' | 'assessed' | 'treating' | 'monitoring' | 'accepted' | 'closed';
export type RiskRating = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
export const RATINGS: readonly RiskRating[] = ['very_low', 'low', 'moderate', 'high', 'very_high'];

/** Likelihood x impact, both 1-5. Throws on anything off the matrix rather than inventing a score. */
export function score(likelihood: number, impact: number): number {
  if (!isLevel(likelihood) || !isLevel(impact)) throw new RangeError(`likelihood and impact must be integers 1-5 (got ${likelihood}, ${impact})`);
  return likelihood * impact;
}

export function isLevel(n: unknown): n is 1 | 2 | 3 | 4 | 5 {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5;
}

/**
 * Band a 1-25 score. Boundaries follow the conventional 5x5 heat map so the colours line up with
 * what risk committees already read: the only scores possible are products of 1-5, and every
 * cell on a given anti-diagonal lands in the same or an adjacent band.
 */
export function rating(s: number): RiskRating {
  if (s >= 20) return 'very_high';
  if (s >= 15) return 'high';
  if (s >= 8) return 'moderate';
  if (s >= 4) return 'low';
  return 'very_low';
}

/**
 * Overall impact from per-dimension impact: the HIGH-WATER MARK, never the average.
 * A breach that is Severe for confidentiality and Negligible everywhere else is a Severe breach;
 * averaging would report it as Minor. Dimensions at 0 mean "not applicable".
 * Returns null when no dimension was rated, so the caller keeps the analyst's direct impact.
 */
export function highWaterImpact(dims: Partial<Record<ImpactDimension, number>> | null | undefined): number | null {
  if (!dims) return null;
  let max = 0;
  for (const k of IMPACT_DIMENSIONS) {
    const v = dims[k];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < 0 || v > 5) throw new RangeError(`impact dimension ${k} must be 0-5`);
    if (v > max) max = v;
  }
  return max === 0 ? null : max;
}

/** Days between reviews, by residual rating. Hotter risks are looked at more often. */
export const REVIEW_DAYS: Record<RiskRating, number> = {
  very_high: 30, high: 60, moderate: 90, low: 180, very_low: 365,
};

export function nextReviewAt(residualScore: number, from: Date, overrideDays?: number | null): Date {
  const days = overrideDays && overrideDays > 0 ? overrideDays : REVIEW_DAYS[rating(residualScore)];
  return new Date(from.getTime() + days * 86_400_000);
}

// ---------------- Appetite ----------------

export type AppetiteState = 'within' | 'above_appetite' | 'above_tolerance';

export interface Appetite { appetite_score: number; tolerance_score: number }
export const DEFAULT_APPETITE: Appetite = { appetite_score: 9, tolerance_score: 15 };

/**
 * Judge residual risk against the organization's thresholds. Appetite is what the organization is
 * comfortable carrying; tolerance is the line it must not cross without leadership sign-off.
 */
export function appetiteState(residualScore: number, a: Appetite = DEFAULT_APPETITE): AppetiteState {
  if (residualScore > a.tolerance_score) return 'above_tolerance';
  if (residualScore > a.appetite_score) return 'above_appetite';
  return 'within';
}

// ---------------- Lifecycle ----------------

const TRANSITIONS: Record<RiskStatus, RiskStatus[]> = {
  identified: ['assessed', 'closed'],
  assessed: ['treating', 'monitoring', 'closed'],
  treating: ['monitoring', 'assessed', 'closed'],
  monitoring: ['treating', 'assessed', 'closed'],
  // Accepted is entered only through the acceptance workflow (never a bare transition), and left
  // by re-assessment — e.g. when the acceptance expires or circumstances change.
  accepted: ['assessed', 'treating', 'closed'],
  closed: ['identified'],
};

export function canTransition(from: RiskStatus, to: RiskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Is a recorded acceptance still in force at `now`? An expired acceptance is not an acceptance. */
export function acceptanceActive(
  r: { acceptance_status: string; acceptance_expires_at: string | Date | null },
  now: Date = new Date(),
): boolean {
  if (r.acceptance_status !== 'approved') return false;
  if (!r.acceptance_expires_at) return false; // acceptances are always time-boxed
  return new Date(r.acceptance_expires_at).getTime() > now.getTime();
}

// ---------------- Treatment ----------------

export interface TreatmentLike { status: string; due_at: string | Date | null }

/** Share of non-cancelled treatment items that are done (0-100), or null with no plan at all. */
export function treatmentProgress(items: TreatmentLike[]): number | null {
  const live = items.filter((t) => t.status !== 'cancelled');
  if (live.length === 0) return null;
  return Math.round((live.filter((t) => t.status === 'done').length / live.length) * 100);
}

export function overdueTreatments(items: TreatmentLike[], now: Date = new Date()): number {
  return items.filter(
    (t) => (t.status === 'planned' || t.status === 'in_progress') && t.due_at && new Date(t.due_at).getTime() < now.getTime(),
  ).length;
}

// ---------------- FAIR quantitative analysis ----------------

export interface Range { min: number; likely: number; max: number }
export interface FairInputs { lef: Range; lm: Range }
export interface FairResults {
  mean: number; p10: number; p50: number; p90: number; p95: number;
  iterations: number; seed: number;
}

export function validateRange(r: Range, name: string): void {
  for (const k of ['min', 'likely', 'max'] as const) {
    if (!Number.isFinite(r[k]) || r[k] < 0) throw new RangeError(`${name}.${k} must be a non-negative number`);
  }
  if (!(r.min <= r.likely && r.likely <= r.max)) throw new RangeError(`${name} must satisfy min <= likely <= max`);
}

/** mulberry32 — tiny, fast, seedable PRNG. Reproducibility matters more than quality here. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  // Box-Muller. 1 - rand() keeps log() away from 0.
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) by Marsaglia-Tsang; boosted for shape < 1. */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) return gamma(shape + 1, rand) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One draw from a PERT(min, likely, max) — the distribution FAIR practitioners estimate in. */
export function samplePert(r: Range, rand: () => number, lambda = 4): number {
  if (r.max === r.min) return r.min;
  const span = r.max - r.min;
  const alpha = 1 + (lambda * (r.likely - r.min)) / span;
  const beta = 1 + (lambda * (r.max - r.likely)) / span;
  const x = gamma(alpha, rand);
  const y = gamma(beta, rand);
  return r.min + (x / (x + y)) * span;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export const FAIR_SEED = 0x5eed;

/**
 * Monte Carlo annualized loss expectancy. Each iteration draws a loss-event frequency (events/yr)
 * and a per-event loss magnitude from their PERT ranges and multiplies them.
 *
 * SEEDED, deliberately: the same inputs always give the same P50, so a number on a board report
 * does not wobble each time someone opens the risk, and the test suite can pin it.
 */
export function simulateFair(inputs: FairInputs, iterations = 10_000, seed = FAIR_SEED): FairResults {
  validateRange(inputs.lef, 'lef');
  validateRange(inputs.lm, 'lm');
  const rand = prng(seed);
  const out = new Array<number>(iterations);
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    const ale = samplePert(inputs.lef, rand) * samplePert(inputs.lm, rand);
    out[i] = ale;
    sum += ale;
  }
  out.sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    mean: round(sum / iterations),
    p10: round(percentile(out, 10)),
    p50: round(percentile(out, 50)),
    p90: round(percentile(out, 90)),
    p95: round(percentile(out, 95)),
    iterations,
    seed,
  };
}

// ---------------- Aggregation ----------------

export interface ScoredRisk {
  organization_id: string;
  status: string;
  inherent_likelihood: number; inherent_impact: number;
  residual_likelihood: number; residual_impact: number;
  target_likelihood: number | null; target_impact: number | null;
  next_review_at: string | Date;
  fair_results?: FairResults | null;
}

export type HeatmapBasis = 'inherent' | 'residual' | 'target';

/**
 * 5x5 counts, indexed [likelihood-1][impact-1]. Closed risks are excluded: a heat map is a picture
 * of what the organization carries NOW. Risks without a target are skipped on the target basis
 * rather than plotted as if their target were their residual.
 */
export function heatmap(risks: ScoredRisk[], basis: HeatmapBasis = 'residual'): number[][] {
  const grid = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  for (const r of risks) {
    if (r.status === 'closed') continue;
    const l = basis === 'inherent' ? r.inherent_likelihood : basis === 'residual' ? r.residual_likelihood : r.target_likelihood;
    const i = basis === 'inherent' ? r.inherent_impact : basis === 'residual' ? r.residual_impact : r.target_impact;
    if (!isLevel(l) || !isLevel(i)) continue;
    grid[l - 1][i - 1]++;
  }
  return grid;
}

export interface OrgRiskSummary {
  organization_id: string;
  open: number;
  by_rating: Record<RiskRating, number>;
  above_appetite: number;
  above_tolerance: number;
  overdue_reviews: number;
  worst_residual: number | null;
  /** Sum of P50 ALE across quantified open risks. Null when nothing is quantified — not $0. */
  ale_p50: number | null;
  ale_p90: number | null;
  quantified: number;
}

/**
 * Roll one organization's open risks into a portfolio row. "Open" is every status except closed;
 * an accepted risk is still carried, and still counts against appetite.
 */
export function summarizeOrg(orgId: string, risks: ScoredRisk[], a: Appetite = DEFAULT_APPETITE, now: Date = new Date()): OrgRiskSummary {
  const open = risks.filter((r) => r.status !== 'closed');
  const by_rating: Record<RiskRating, number> = { very_low: 0, low: 0, moderate: 0, high: 0, very_high: 0 };
  let above_appetite = 0;
  let above_tolerance = 0;
  let overdue = 0;
  let worst: number | null = null;
  let p50 = 0;
  let p90 = 0;
  let quantified = 0;
  for (const r of open) {
    const s = r.residual_likelihood * r.residual_impact;
    by_rating[rating(s)]++;
    const st = appetiteState(s, a);
    if (st !== 'within') above_appetite++;
    if (st === 'above_tolerance') above_tolerance++;
    if (new Date(r.next_review_at).getTime() < now.getTime()) overdue++;
    worst = worst === null ? s : Math.max(worst, s);
    if (r.fair_results) {
      quantified++;
      p50 += Number(r.fair_results.p50);
      p90 += Number(r.fair_results.p90);
    }
  }
  return {
    organization_id: orgId,
    open: open.length,
    by_rating,
    above_appetite,
    above_tolerance,
    overdue_reviews: overdue,
    worst_residual: worst,
    ale_p50: quantified ? Math.round(p50) : null,
    ale_p90: quantified ? Math.round(p90) : null,
    quantified,
  };
}

/**
 * Order a portfolio worst-first: above tolerance, then above appetite, then worst residual, then
 * overdue reviews. Same principle as the posture rollup — the customer in trouble goes on top,
 * not wherever the alphabet puts it.
 */
export function rankPortfolio<T extends OrgRiskSummary>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      b.above_tolerance - a.above_tolerance ||
      b.above_appetite - a.above_appetite ||
      (b.worst_residual ?? 0) - (a.worst_residual ?? 0) ||
      b.overdue_reviews - a.overdue_reviews,
  );
}

// ---------------- Seeding from posture ----------------

/** Starting likelihood/impact for a risk raised from a posture finding of a given severity. */
export function fromFindingSeverity(severity: string): { likelihood: number; impact: number } {
  switch (severity) {
    case 'critical': return { likelihood: 4, impact: 5 };
    case 'high': return { likelihood: 4, impact: 4 };
    case 'moderate': return { likelihood: 3, impact: 3 };
    case 'low': return { likelihood: 2, impact: 2 };
    default: return { likelihood: 1, impact: 2 };
  }
}

// ---------------- Export ----------------

export function riskRef(n: number): string {
  return `R-${String(n).padStart(4, '0')}`;
}

/**
 * One CSV cell. Quotes when needed, and neutralises spreadsheet formula injection: a title such as
 * `=HYPERLINK("http://evil","click")` would otherwise execute when an auditor opens the export.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

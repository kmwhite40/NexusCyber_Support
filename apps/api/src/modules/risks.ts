// Risk register — one register per organization (migration 0085).
//
// This module is authorization, SQL and audit. Every scoring / lifecycle / appetite rule lives in
// risk-scoring.ts as a pure function, so the rules are tested without a database and cannot drift
// between the list view, the detail view, the portfolio and the CSV export.
//
// ORGANIZATION SEPARATION is enforced three times, independently:
//   1. the PDP (authorize(..., { organizationId })) — the principal's role and org scope;
//   2. Postgres RLS on every risk table, set from the principal by withOrgContext;
//   3. here: every child row (treatment, link, history) is written with the PARENT's organization,
//      and every linked object (finding, ticket, …) must belong to that same organization.
import { withOrgContext, withSystemContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import { resolveUserNames, nameRef } from './user-names.js';
import { readableOrganizations } from './posture.js';
import type { Principal } from '../types.js';
import {
  score, rating, highWaterImpact, nextReviewAt, appetiteState, canTransition, acceptanceActive,
  treatmentProgress, overdueTreatments, simulateFair, summarizeOrg, rankPortfolio, fromFindingSeverity,
  riskRef, toCsv, DEFAULT_APPETITE, isLevel,
  type Appetite, type FairInputs, type RiskStatus, type ImpactDimension, type RiskCategory, type OrgRiskSummary,
} from './risk-scoring.js';

// ---------------- Scope ----------------

/** The organization a call acts on. Customers act on their own org, whatever they send. */
function resolveOrg(actor: Principal, orgId?: string | null): string {
  if (actor.plane === 'customer') {
    if (!actor.organizationId) throw Errors.forbidden('no organization');
    if (orgId && orgId !== actor.organizationId) throw Errors.forbidden('out of organization scope');
    return actor.organizationId;
  }
  if (!orgId) throw Errors.badRequest('organizationId required');
  return orgId;
}

// ---------------- Settings (appetite) ----------------

export interface RiskSettings extends Appetite { organization_id: string; max_acceptance_days: number; is_default: boolean }

async function loadSettings(sql: Sql, orgId: string): Promise<RiskSettings> {
  const row = (await sql.query('SELECT * FROM risk_org_settings WHERE organization_id=$1', [orgId])).rows[0];
  if (!row) return { organization_id: orgId, ...DEFAULT_APPETITE, max_acceptance_days: 365, is_default: true };
  return {
    organization_id: orgId,
    appetite_score: row.appetite_score,
    tolerance_score: row.tolerance_score,
    max_acceptance_days: row.max_acceptance_days,
    is_default: false,
  };
}

export async function getSettings(actor: Principal, orgId?: string | null): Promise<RiskSettings> {
  const org = resolveOrg(actor, orgId);
  authorize(actor, 'risk.read', { organizationId: org });
  return withOrgContext(orgContextFor(actor), (sql) => loadSettings(sql, org));
}

export interface SettingsInput { appetiteScore: number; toleranceScore: number; maxAcceptanceDays?: number }

/** Setting appetite is a governance decision, so it needs risk.accept, not risk.manage. */
export async function putSettings(actor: Principal, orgId: string | null | undefined, input: SettingsInput): Promise<RiskSettings> {
  const org = resolveOrg(actor, orgId);
  authorize(actor, 'risk.accept', { organizationId: org });
  if (input.appetiteScore > input.toleranceScore) throw Errors.validation('appetite cannot exceed tolerance', [{ field: 'appetiteScore', message: 'must be ≤ tolerance' }]);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    await sql.query(
      `INSERT INTO risk_org_settings (organization_id, appetite_score, tolerance_score, max_acceptance_days, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (organization_id) DO UPDATE SET appetite_score=EXCLUDED.appetite_score,
         tolerance_score=EXCLUDED.tolerance_score, max_acceptance_days=EXCLUDED.max_acceptance_days,
         updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [org, input.appetiteScore, input.toleranceScore, input.maxAcceptanceDays ?? 365, actor.id],
    );
    await audit(actor, { action: 'risk.settings.update', organizationId: org, resourceType: 'organization', resourceId: org, detail: { ...input } });
    return loadSettings(sql, org);
  });
}

// ---------------- Decoration ----------------

/** Derived fields every reader gets, computed in one place. */
function decorate(r: any, settings: Appetite, extra: { treatments?: any[] } = {}, now = new Date()) {
  const treatments = extra.treatments;
  return {
    ...r,
    ref: riskRef(r.risk_number),
    inherent_rating: rating(r.inherent_score),
    residual_rating: rating(r.residual_score),
    target_rating: r.target_score ? rating(r.target_score) : null,
    appetite_state: appetiteState(r.residual_score, settings),
    acceptance_active: acceptanceActive(r, now),
    review_overdue: r.status !== 'closed' && new Date(r.next_review_at).getTime() < now.getTime(),
    ...(treatments
      ? { treatment_progress: treatmentProgress(treatments), treatments_overdue: overdueTreatments(treatments, now) }
      : {}),
  };
}

// ---------------- List / portfolio ----------------

export interface ListFilter {
  status?: string;
  category?: string;
  rating?: string;
  q?: string;
  ownerId?: string;
  includeClosed?: boolean;
}

export async function listRisks(actor: Principal, orgId: string | null | undefined, filter: ListFilter = {}) {
  const org = resolveOrg(actor, orgId);
  authorize(actor, 'risk.read', { organizationId: org });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const settings = await loadSettings(sql, org);
    const where = ['r.organization_id=$1'];
    const params: unknown[] = [org];
    if (filter.status) { params.push(filter.status); where.push(`r.status=$${params.length}`); }
    else if (!filter.includeClosed) where.push(`r.status <> 'closed'`);
    if (filter.category) { params.push(filter.category); where.push(`r.category=$${params.length}`); }
    if (filter.ownerId) { params.push(filter.ownerId); where.push(`r.owner_id=$${params.length}`); }
    if (filter.q) {
      params.push(`%${filter.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      where.push(`(r.title ILIKE $${params.length} OR r.description ILIKE $${params.length} OR ('R-' || lpad(r.risk_number::text, 4, '0')) ILIKE $${params.length})`);
    }
    const { rows } = await sql.query(
      `SELECT r.*,
              (SELECT count(*)::int FROM risk_treatments t WHERE t.risk_id=r.id AND t.status <> 'cancelled') AS treatment_count,
              (SELECT count(*)::int FROM risk_treatments t WHERE t.risk_id=r.id AND t.status = 'done') AS treatment_done,
              (SELECT count(*)::int FROM risk_treatments t WHERE t.risk_id=r.id AND t.status IN ('planned','in_progress') AND t.due_at < now()) AS treatments_overdue,
              (SELECT count(*)::int FROM risk_links l WHERE l.risk_id=r.id) AS link_count
         FROM risks r WHERE ${where.join(' AND ')}
        ORDER BY r.residual_score DESC, r.inherent_score DESC, r.risk_number`,
      params,
    );
    const names = await resolveUserNames(rows.map((r: any) => r.owner_id));
    const out = rows.map((r: any) => ({
      ...decorate(r, settings),
      owner: nameRef(names, r.owner_id),
      treatment_progress: r.treatment_count ? Math.round((r.treatment_done / r.treatment_count) * 100) : null,
    }));
    return filter.rating ? out.filter((r: any) => r.residual_rating === filter.rating) : out;
  });
}

export interface PortfolioRow extends OrgRiskSummary { organization_name: string; appetite_score: number; tolerance_score: number }

/**
 * One row per organization the caller can read, worst-first. Organizations are summarized
 * separately — never pooled into one heat map — because each is judged against its own appetite.
 */
export async function portfolio(actor: Principal): Promise<PortfolioRow[]> {
  const orgs = (await readableOrganizations(actor)).filter((o) => can(actor, 'risk.read', { organizationId: o }));
  if (orgs.length === 0) return [];
  const names = await withSystemContext(async (sql) =>
    new Map((await sql.query('SELECT id, name FROM organizations WHERE id = ANY($1::uuid[])', [orgs])).rows.map((r: any) => [r.id, r.name])),
  );
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const risks = (await sql.query(
      `SELECT organization_id, status, inherent_likelihood, inherent_impact, residual_likelihood, residual_impact,
              target_likelihood, target_impact, next_review_at, fair_results
         FROM risks WHERE organization_id = ANY($1::uuid[]) AND status <> 'closed'`,
      [orgs],
    )).rows;
    const settingsRows = (await sql.query('SELECT * FROM risk_org_settings WHERE organization_id = ANY($1::uuid[])', [orgs])).rows;
    const settingsBy = new Map(settingsRows.map((s: any) => [s.organization_id, s]));
    const rows: PortfolioRow[] = orgs.map((o) => {
      const s: Appetite = settingsBy.get(o) ?? DEFAULT_APPETITE;
      return {
        ...summarizeOrg(o, risks.filter((r: any) => r.organization_id === o), s),
        organization_name: (names.get(o) as string) ?? 'Unknown organization',
        appetite_score: s.appetite_score,
        tolerance_score: s.tolerance_score,
      };
    });
    return rankPortfolio(rows);
  });
}

// ---------------- Create / read ----------------

export interface ImpactDims { [k: string]: number }

export interface RiskInput {
  title?: string;
  description?: string | null;
  cause?: string | null;
  event?: string | null;
  consequence?: string | null;
  category?: RiskCategory;
  threatSource?: 'adversarial' | 'accidental' | 'structural' | 'environmental' | null;
  strategy?: 'mitigate' | 'transfer' | 'avoid' | 'accept' | null;
  ownerId?: string | null;
  ownerName?: string | null;
  inherentLikelihood?: number;
  inherentImpact?: number;
  residualLikelihood?: number;
  residualImpact?: number;
  targetLikelihood?: number | null;
  targetImpact?: number | null;
  impactDimensions?: Partial<Record<ImpactDimension, number>>;
  velocity?: 'slow' | 'moderate' | 'rapid' | 'immediate' | null;
  fair?: FairInputs | null;
  reviewFrequencyDays?: number | null;
  tags?: string[];
  note?: string;
}

export interface CreateRiskInput extends RiskInput {
  organizationId?: string;
  title: string;
  inherentLikelihood: number;
  inherentImpact: number;
}

function checkLevels(input: RiskInput) {
  const pairs: Array<[string, unknown]> = [
    ['inherentLikelihood', input.inherentLikelihood], ['inherentImpact', input.inherentImpact],
    ['residualLikelihood', input.residualLikelihood], ['residualImpact', input.residualImpact],
    ['targetLikelihood', input.targetLikelihood], ['targetImpact', input.targetImpact],
  ];
  const bad = pairs.filter(([, v]) => v !== undefined && v !== null && !isLevel(v));
  if (bad.length) throw Errors.validation('likelihood and impact must be 1-5', bad.map(([field]) => ({ field, message: 'must be 1-5' })));
  if ((input.targetLikelihood == null) !== (input.targetImpact == null) && input.targetLikelihood !== undefined && input.targetImpact !== undefined) {
    throw Errors.validation('target likelihood and impact are set together', [{ field: 'targetImpact', message: 'set both or neither' }]);
  }
}

function runFair(fair: FairInputs | null | undefined) {
  if (!fair) return null;
  try {
    return simulateFair(fair);
  } catch (e) {
    throw Errors.validation((e as Error).message, [{ field: 'fair', message: (e as Error).message }]);
  }
}

/** An owner must be a Nexus staff member or a user of THIS organization — never another tenant's. */
async function checkOwner(orgId: string, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const ok = await withSystemContext(async (sql) =>
    (await sql.query(`SELECT 1 FROM users WHERE id=$1 AND (plane='nexus' OR organization_id=$2)`, [ownerId, orgId])).rows.length > 0,
  );
  if (!ok) throw Errors.validation('owner must belong to this organization', [{ field: 'ownerId', message: 'not a member of this organization' }]);
}

async function writeHistory(sql: Sql, actor: Principal | null, r: any, kind: string, note?: string | null) {
  await sql.query(
    `INSERT INTO risk_history (organization_id, risk_id, kind, inherent_score, residual_score, target_score,
        residual_likelihood, residual_impact, status, ale_p50, note, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [r.organization_id, r.id, kind, r.inherent_score, r.residual_score, r.target_score, r.residual_likelihood,
      r.residual_impact, r.status, r.fair_results?.p50 ?? null, note ?? null, actor?.id ?? null],
  );
}

export async function createRisk(actor: Principal, input: CreateRiskInput, opts: { link?: { kind: string; ref: string; label?: string } } = {}) {
  const org = resolveOrg(actor, input.organizationId);
  authorize(actor, 'risk.manage', { organizationId: org });
  checkLevels(input);
  await checkOwner(org, input.ownerId);

  // Impact dimensions, when given, set the impact by high-water mark (FIPS 199).
  const hw = highWaterImpact(input.impactDimensions);
  const inherentImpact = hw ?? input.inherentImpact;
  // With no residual given, residual starts at inherent: nothing has been credited yet.
  const residualL = input.residualLikelihood ?? input.inherentLikelihood;
  const residualI = input.residualImpact ?? inherentImpact;
  score(residualL, residualI);
  const fairResults = runFair(input.fair);
  const now = new Date();
  const next = nextReviewAt(residualL * residualI, now, input.reviewFrequencyDays);
  const status: RiskStatus = input.residualLikelihood !== undefined ? 'assessed' : 'identified';

  return withOrgContext(orgContextFor(actor), async (sql) => {
    // Serialize numbering per organization: two analysts filing at once must not both get R-0007.
    await sql.query(`SELECT pg_advisory_xact_lock(hashtext('risk_number:' || $1))`, [org]);
    const n = (await sql.query('SELECT coalesce(max(risk_number),0)+1 AS n FROM risks WHERE organization_id=$1', [org])).rows[0].n;
    const { rows } = await sql.query(
      `INSERT INTO risks (organization_id, risk_number, title, description, cause, event, consequence, category,
          threat_source, status, strategy, owner_id, owner_name,
          inherent_likelihood, inherent_impact, residual_likelihood, residual_impact, target_likelihood, target_impact,
          impact_dimensions, velocity, fair_inputs, fair_results, review_frequency_days, last_reviewed_at, next_review_at,
          tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       RETURNING *`,
      [org, n, input.title, input.description ?? null, input.cause ?? null, input.event ?? null, input.consequence ?? null,
        input.category ?? 'cybersecurity', input.threatSource ?? null, status, input.strategy ?? null,
        input.ownerId ?? null, input.ownerName ?? null,
        input.inherentLikelihood, inherentImpact, residualL, residualI, input.targetLikelihood ?? null, input.targetImpact ?? null,
        JSON.stringify(input.impactDimensions ?? {}), input.velocity ?? null,
        input.fair ? JSON.stringify(input.fair) : null, fairResults ? JSON.stringify(fairResults) : null,
        input.reviewFrequencyDays ?? null, now, next, input.tags ?? [], actor.id],
    );
    const risk = rows[0];
    await writeHistory(sql, actor, risk, 'created', input.note);
    if (opts.link) {
      await sql.query(
        `INSERT INTO risk_links (organization_id, risk_id, kind, ref, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [org, risk.id, opts.link.kind, opts.link.ref, opts.link.label ?? null, actor.id],
      );
    }
    await audit(actor, { action: 'risk.create', organizationId: org, resourceType: 'risk', resourceId: risk.id, detail: { ref: riskRef(n), residual: risk.residual_score } });
    publish('risk.created', org, { risk_id: risk.id, org_id: org, residual_score: risk.residual_score });
    return decorate(risk, await loadSettings(sql, org));
  });
}

async function loadRisk(sql: Sql, id: string) {
  const r = (await sql.query('SELECT * FROM risks WHERE id=$1', [id])).rows[0];
  if (!r) throw Errors.notFound('risk not found');
  return r;
}

export async function getRisk(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const r = await loadRisk(sql, id);
    authorize(actor, 'risk.read', { organizationId: r.organization_id });
    const settings = await loadSettings(sql, r.organization_id);
    const treatments = (await sql.query('SELECT * FROM risk_treatments WHERE risk_id=$1 ORDER BY coalesce(due_at, created_at), created_at', [id])).rows;
    const links = (await sql.query('SELECT * FROM risk_links WHERE risk_id=$1 ORDER BY kind, created_at', [id])).rows;
    const history = (await sql.query('SELECT * FROM risk_history WHERE risk_id=$1 ORDER BY created_at', [id])).rows;
    const names = await resolveUserNames([
      r.owner_id, r.created_by, r.acceptance_requested_by, r.acceptance_decided_by,
      ...treatments.map((t: any) => t.owner_id), ...history.map((h: any) => h.actor_id),
    ]);
    return {
      ...decorate(r, settings, { treatments }),
      owner: nameRef(names, r.owner_id),
      created_by_user: nameRef(names, r.created_by),
      acceptance_requested_by_user: nameRef(names, r.acceptance_requested_by),
      acceptance_decided_by_user: nameRef(names, r.acceptance_decided_by),
      settings,
      treatments: treatments.map((t: any) => ({ ...t, owner: nameRef(names, t.owner_id) })),
      links,
      history: history.map((h: any) => ({ ...h, actor: nameRef(names, h.actor_id) })),
    };
  });
}

// ---------------- Update / review / transition ----------------

const SCORE_FIELDS = ['inherentLikelihood', 'inherentImpact', 'residualLikelihood', 'residualImpact', 'targetLikelihood', 'targetImpact', 'impactDimensions'] as const;

export async function updateRisk(actor: Principal, id: string, input: RiskInput) {
  checkLevels(input);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = await loadRisk(sql, id);
    authorize(actor, 'risk.manage', { organizationId: cur.organization_id });
    if (input.ownerId !== undefined) await checkOwner(cur.organization_id, input.ownerId);

    const pick = <T>(v: T | undefined, fallback: T) => (v === undefined ? fallback : v);
    const dims = pick(input.impactDimensions, cur.impact_dimensions);
    const hw = input.impactDimensions !== undefined ? highWaterImpact(input.impactDimensions) : null;
    const next = {
      inherent_likelihood: pick(input.inherentLikelihood, cur.inherent_likelihood),
      inherent_impact: hw ?? pick(input.inherentImpact, cur.inherent_impact),
      residual_likelihood: pick(input.residualLikelihood, cur.residual_likelihood),
      residual_impact: pick(input.residualImpact, cur.residual_impact),
      target_likelihood: pick(input.targetLikelihood, cur.target_likelihood),
      target_impact: pick(input.targetImpact, cur.target_impact),
    };
    if ((next.target_likelihood == null) !== (next.target_impact == null)) {
      throw Errors.validation('target likelihood and impact are set together', [{ field: 'targetImpact', message: 'set both or neither' }]);
    }
    const rescored = SCORE_FIELDS.some((f) => input[f] !== undefined) || input.reviewFrequencyDays !== undefined;
    const fairChanged = input.fair !== undefined;
    const fairResults = fairChanged ? runFair(input.fair) : cur.fair_results;
    const reviewDays = pick(input.reviewFrequencyDays, cur.review_frequency_days);
    // Re-assessing IS a review: it restarts the review clock from now.
    const now = new Date();
    const lastReviewed = rescored ? now : cur.last_reviewed_at;
    const nextReview = rescored ? nextReviewAt(next.residual_likelihood * next.residual_impact, now, reviewDays) : cur.next_review_at;
    // 'accept' is a strategy only the acceptance workflow may set; an edit setting it would claim an
    // acceptance nobody with risk.accept ever granted.
    if (input.strategy === 'accept' && cur.strategy !== 'accept') {
      throw Errors.validation('use the acceptance workflow to accept a risk', [{ field: 'strategy', message: 'request acceptance instead' }]);
    }
    // An acceptance (granted or pending) is a decision about the score the approver SAW. Re-scoring
    // after the fact must void it: otherwise a risk accepted at residual 6 could be re-scored to 25
    // and still read as accepted — leadership "accepting" a risk it never looked at.
    const voidAcceptance = rescored && (cur.acceptance_status === 'approved' || cur.acceptance_status === 'requested');
    // A risk that is assessed for the first time leaves 'identified'; a voided acceptance leaves 'accepted'.
    const status =
      rescored && cur.status === 'identified' ? 'assessed'
      : voidAcceptance && cur.status === 'accepted' ? 'assessed'
      : cur.status;
    const strategy = voidAcceptance && pick(input.strategy, cur.strategy) === 'accept' ? null : pick(input.strategy, cur.strategy);

    const { rows } = await sql.query(
      `UPDATE risks SET title=$2, description=$3, cause=$4, event=$5, consequence=$6, category=$7, threat_source=$8,
          strategy=$9, owner_id=$10, owner_name=$11,
          inherent_likelihood=$12, inherent_impact=$13, residual_likelihood=$14, residual_impact=$15,
          target_likelihood=$16, target_impact=$17, impact_dimensions=$18, velocity=$19,
          fair_inputs=$20, fair_results=$21, review_frequency_days=$22, last_reviewed_at=$23, next_review_at=$24,
          tags=$25, status=$26, updated_at=now()
          ${voidAcceptance ? ", acceptance_status='none', acceptance_expires_at=NULL, acceptance_decided_by=NULL, acceptance_decided_at=NULL" : ''}
        WHERE id=$1 RETURNING *`,
      [id, pick(input.title, cur.title), pick(input.description, cur.description), pick(input.cause, cur.cause),
        pick(input.event, cur.event), pick(input.consequence, cur.consequence), pick(input.category, cur.category),
        pick(input.threatSource, cur.threat_source), strategy,
        pick(input.ownerId, cur.owner_id), pick(input.ownerName, cur.owner_name),
        next.inherent_likelihood, next.inherent_impact, next.residual_likelihood, next.residual_impact,
        next.target_likelihood, next.target_impact, JSON.stringify(dims ?? {}), pick(input.velocity, cur.velocity),
        fairChanged ? (input.fair ? JSON.stringify(input.fair) : null) : cur.fair_inputs ? JSON.stringify(cur.fair_inputs) : null,
        fairResults ? JSON.stringify(fairResults) : null,
        reviewDays, lastReviewed, nextReview, pick(input.tags, cur.tags), status],
    );
    const risk = rows[0];
    if (voidAcceptance) {
      await writeHistory(sql, actor, risk, 'acceptance_voided', `Re-scored from residual ${cur.residual_score}; the ${cur.acceptance_status} acceptance no longer applies`);
      await audit(actor, { action: 'risk.acceptance.void', organizationId: cur.organization_id, resourceType: 'risk', resourceId: id, detail: { was: cur.acceptance_status, residual_from: cur.residual_score, residual_to: risk.residual_score } });
    }
    if (rescored || fairChanged || input.note) {
      await writeHistory(sql, actor, risk, rescored || fairChanged ? 'reassessed' : 'note', input.note);
    }
    await audit(actor, {
      action: 'risk.update', organizationId: cur.organization_id, resourceType: 'risk', resourceId: id,
      detail: rescored ? { residual_from: cur.residual_score, residual_to: risk.residual_score } : {},
    });
    if (rescored && risk.residual_score !== cur.residual_score) {
      publish('risk.rescored', cur.organization_id, { risk_id: id, from: cur.residual_score, to: risk.residual_score });
    }
    return decorate(risk, await loadSettings(sql, cur.organization_id));
  });
}

/** Periodic review with no score change: restarts the review clock and records who looked. */
export async function markReviewed(actor: Principal, id: string, note?: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = await loadRisk(sql, id);
    authorize(actor, 'risk.manage', { organizationId: cur.organization_id });
    const now = new Date();
    const { rows } = await sql.query(
      'UPDATE risks SET last_reviewed_at=$2, next_review_at=$3, updated_at=now() WHERE id=$1 RETURNING *',
      [id, now, nextReviewAt(cur.residual_score, now, cur.review_frequency_days)],
    );
    await writeHistory(sql, actor, rows[0], 'reviewed', note);
    await audit(actor, { action: 'risk.review', organizationId: cur.organization_id, resourceType: 'risk', resourceId: id });
    return decorate(rows[0], await loadSettings(sql, cur.organization_id));
  });
}

export async function transitionRisk(actor: Principal, id: string, to: RiskStatus, note?: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = await loadRisk(sql, id);
    authorize(actor, 'risk.manage', { organizationId: cur.organization_id });
    if (to === 'accepted') throw Errors.badRequest('use the acceptance workflow to accept a risk');
    if (!canTransition(cur.status, to)) throw Errors.conflict(`cannot move risk from ${cur.status} to ${to}`);
    // Leaving 'accepted' ends the acceptance — it must not silently survive a re-open.
    const clearAcceptance = cur.status === 'accepted';
    const { rows } = await sql.query(
      `UPDATE risks SET status=$2, closed_at=$3, updated_at=now()
         ${clearAcceptance ? ", acceptance_status='none', acceptance_expires_at=NULL" : ''}
        WHERE id=$1 RETURNING *`,
      [id, to, to === 'closed' ? new Date() : null],
    );
    await writeHistory(sql, actor, rows[0], 'status', note ?? `${cur.status} → ${to}`);
    await audit(actor, { action: `risk.${to}`, organizationId: cur.organization_id, resourceType: 'risk', resourceId: id, detail: { from: cur.status } });
    publish('risk.status_changed', cur.organization_id, { risk_id: id, from: cur.status, to });
    return decorate(rows[0], await loadSettings(sql, cur.organization_id));
  });
}

// ---------------- Acceptance (SoD) ----------------

export async function requestAcceptance(actor: Principal, id: string, input: { justification: string; expiresAt: string }) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = await loadRisk(sql, id);
    authorize(actor, 'risk.manage', { organizationId: cur.organization_id });
    if (cur.status === 'closed') throw Errors.conflict('a closed risk cannot be accepted');
    if (cur.acceptance_status === 'requested') throw Errors.conflict('an acceptance is already awaiting a decision');
    const settings = await loadSettings(sql, cur.organization_id);
    const expires = new Date(input.expiresAt);
    const now = Date.now();
    if (!(expires.getTime() > now)) throw Errors.validation('expiry must be in the future', [{ field: 'expiresAt', message: 'must be in the future' }]);
    if (expires.getTime() > now + settings.max_acceptance_days * 86_400_000) {
      throw Errors.validation(`acceptances at this organization last at most ${settings.max_acceptance_days} days`, [{ field: 'expiresAt', message: `at most ${settings.max_acceptance_days} days out` }]);
    }
    const { rows } = await sql.query(
      `UPDATE risks SET acceptance_status='requested', acceptance_justification=$2, acceptance_expires_at=$3,
          acceptance_requested_by=$4, acceptance_decided_by=NULL, acceptance_decided_at=NULL, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, input.justification, expires, actor.id],
    );
    await writeHistory(sql, actor, rows[0], 'acceptance_requested', input.justification);
    await audit(actor, { action: 'risk.acceptance.request', organizationId: cur.organization_id, resourceType: 'risk', resourceId: id, detail: { expiresAt: input.expiresAt, residual: cur.residual_score } });
    publish('risk.acceptance_requested', cur.organization_id, { risk_id: id, residual_score: cur.residual_score });
    return decorate(rows[0], settings);
  });
}

export async function decideAcceptance(actor: Principal, id: string, approve: boolean, note?: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = await loadRisk(sql, id);
    authorize(actor, 'risk.accept', { organizationId: cur.organization_id });
    if (cur.acceptance_status !== 'requested') throw Errors.conflict('no acceptance is awaiting a decision');
    if (cur.acceptance_requested_by === actor.id) throw Errors.forbidden('separation of duties: the requester cannot approve their own acceptance');
    const { rows } = await sql.query(
      approve
        ? `UPDATE risks SET acceptance_status='approved', acceptance_decided_by=$2, acceptance_decided_at=now(),
              status='accepted', strategy='accept', updated_at=now() WHERE id=$1 RETURNING *`
        : `UPDATE risks SET acceptance_status='rejected', acceptance_decided_by=$2, acceptance_decided_at=now(),
              updated_at=now() WHERE id=$1 RETURNING *`,
      [id, actor.id],
    );
    await writeHistory(sql, actor, rows[0], approve ? 'accepted' : 'acceptance_rejected', note);
    await audit(actor, { action: approve ? 'risk.acceptance.approve' : 'risk.acceptance.reject', organizationId: cur.organization_id, resourceType: 'risk', resourceId: id, detail: { residual: cur.residual_score } });
    publish(approve ? 'risk.accepted' : 'risk.acceptance_rejected', cur.organization_id, { risk_id: id });
    return decorate(rows[0], await loadSettings(sql, cur.organization_id));
  });
}

// ---------------- Treatments ----------------

export interface TreatmentInput {
  title?: string;
  description?: string | null;
  ownerId?: string | null;
  status?: 'planned' | 'in_progress' | 'done' | 'cancelled';
  dueAt?: string | null;
  costEstimate?: number | null;
  ticketId?: string | null;
}

async function checkSameOrgTicket(sql: Sql, orgId: string, ticketId: string | null | undefined) {
  if (!ticketId) return;
  const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!t || t.organization_id !== orgId) throw Errors.validation('ticket not found in this organization', [{ field: 'ticketId', message: 'not in this organization' }]);
}

export async function addTreatment(actor: Principal, riskId: string, input: TreatmentInput & { title: string }) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const r = await loadRisk(sql, riskId);
    authorize(actor, 'risk.manage', { organizationId: r.organization_id });
    await checkOwner(r.organization_id, input.ownerId);
    await checkSameOrgTicket(sql, r.organization_id, input.ticketId);
    const { rows } = await sql.query(
      `INSERT INTO risk_treatments (organization_id, risk_id, title, description, owner_id, status, due_at, cost_estimate, ticket_id, created_by, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [r.organization_id, riskId, input.title, input.description ?? null, input.ownerId ?? null, input.status ?? 'planned',
        input.dueAt ?? null, input.costEstimate ?? null, input.ticketId ?? null, actor.id, input.status === 'done' ? new Date() : null],
    );
    // Planning a treatment means the risk is being treated.
    if (r.status === 'assessed' || r.status === 'identified') {
      await sql.query(`UPDATE risks SET status='treating', strategy=coalesce(strategy,'mitigate'), updated_at=now() WHERE id=$1`, [riskId]);
    }
    await audit(actor, { action: 'risk.treatment.create', organizationId: r.organization_id, resourceType: 'risk', resourceId: riskId, detail: { treatmentId: rows[0].id } });
    return rows[0];
  });
}

export async function updateTreatment(actor: Principal, riskId: string, treatmentId: string, input: TreatmentInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const r = await loadRisk(sql, riskId);
    authorize(actor, 'risk.manage', { organizationId: r.organization_id });
    const cur = (await sql.query('SELECT * FROM risk_treatments WHERE id=$1 AND risk_id=$2', [treatmentId, riskId])).rows[0];
    if (!cur) throw Errors.notFound('treatment not found');
    if (input.ownerId !== undefined) await checkOwner(r.organization_id, input.ownerId);
    if (input.ticketId !== undefined) await checkSameOrgTicket(sql, r.organization_id, input.ticketId);
    const pick = <T>(v: T | undefined, f: T) => (v === undefined ? f : v);
    const status = pick(input.status, cur.status);
    const completedAt = status === 'done' ? cur.completed_at ?? new Date() : null;
    const { rows } = await sql.query(
      `UPDATE risk_treatments SET title=$2, description=$3, owner_id=$4, status=$5, due_at=$6, cost_estimate=$7,
          ticket_id=$8, completed_at=$9, updated_at=now() WHERE id=$1 RETURNING *`,
      [treatmentId, pick(input.title, cur.title), pick(input.description, cur.description), pick(input.ownerId, cur.owner_id),
        status, pick(input.dueAt, cur.due_at), pick(input.costEstimate, cur.cost_estimate), pick(input.ticketId, cur.ticket_id), completedAt],
    );
    await audit(actor, { action: 'risk.treatment.update', organizationId: r.organization_id, resourceType: 'risk', resourceId: riskId, detail: { treatmentId, status } });
    return rows[0];
  });
}

// ---------------- Links ----------------

export type LinkKind = 'control' | 'finding' | 'ticket' | 'problem' | 'change' | 'service';

const LINK_TABLES: Record<Exclude<LinkKind, 'control'>, { table: string; label: string }> = {
  finding: { table: 'posture_findings', label: 'title' },
  ticket: { table: 'tickets', label: `ticket_number || ' · ' || subject` },
  problem: { table: 'problems', label: 'title' },
  change: { table: 'changes', label: 'title' },
  service: { table: 'services', label: 'name' },
};

/** Resolve a link target and its label, refusing anything outside the risk's organization. */
async function resolveLink(sql: Sql, orgId: string, kind: LinkKind, ref: string): Promise<string> {
  if (kind === 'control') {
    const c = await withSystemContext(async (s) => (await s.query('SELECT control_id, title FROM compliance_controls WHERE control_id=$1', [ref])).rows[0]);
    if (!c) throw Errors.validation('unknown control', [{ field: 'ref', message: 'no such control' }]);
    return `${c.control_id} · ${c.title}`;
  }
  if (!/^[0-9a-f-]{36}$/i.test(ref)) throw Errors.validation('ref must be a uuid', [{ field: 'ref', message: 'must be a uuid' }]);
  const t = LINK_TABLES[kind];
  // Table and label come from the constant map above, never from input.
  const row = (await sql.query(`SELECT organization_id, ${t.label} AS label FROM ${t.table} WHERE id=$1`, [ref])).rows[0];
  if (!row || row.organization_id !== orgId) throw Errors.validation(`${kind} not found in this organization`, [{ field: 'ref', message: 'not in this organization' }]);
  return row.label;
}

export async function addLink(actor: Principal, riskId: string, kind: LinkKind, ref: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const r = await loadRisk(sql, riskId);
    authorize(actor, 'risk.manage', { organizationId: r.organization_id });
    const label = await resolveLink(sql, r.organization_id, kind, ref);
    const { rows } = await sql.query(
      `INSERT INTO risk_links (organization_id, risk_id, kind, ref, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (risk_id, kind, ref) DO UPDATE SET label=EXCLUDED.label RETURNING *`,
      [r.organization_id, riskId, kind, ref, label, actor.id],
    );
    await audit(actor, { action: 'risk.link.add', organizationId: r.organization_id, resourceType: 'risk', resourceId: riskId, detail: { kind, ref } });
    return rows[0];
  });
}

export async function removeLink(actor: Principal, riskId: string, linkId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const r = await loadRisk(sql, riskId);
    authorize(actor, 'risk.manage', { organizationId: r.organization_id });
    const { rowCount } = await sql.query('DELETE FROM risk_links WHERE id=$1 AND risk_id=$2', [linkId, riskId]);
    if (!rowCount) throw Errors.notFound('link not found');
    await audit(actor, { action: 'risk.link.remove', organizationId: r.organization_id, resourceType: 'risk', resourceId: riskId, detail: { linkId } });
    return { ok: true };
  });
}

// ---------------- Posture integration ----------------

/** Open high/critical posture findings in an organization that no risk covers yet. */
export async function findingCandidates(actor: Principal, orgId?: string | null) {
  const org = resolveOrg(actor, orgId);
  authorize(actor, 'risk.read', { organizationId: org });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT f.id, f.title, f.domain, f.severity, f.status, f.remediation_due_at
         FROM posture_findings f
        WHERE f.organization_id=$1 AND f.severity IN ('critical','high')
          AND f.status NOT IN ('remediated','closed','accepted')
          AND NOT EXISTS (SELECT 1 FROM risk_links l WHERE l.kind='finding' AND l.ref = f.id::text)
        ORDER BY CASE f.severity WHEN 'critical' THEN 1 ELSE 2 END, f.created_at DESC`,
      [org],
    );
    return rows;
  });
}

/** Raise a risk from a posture finding, pre-assessed from its severity and linked back to it. */
export async function createFromFinding(actor: Principal, findingId: string) {
  const f = await withOrgContext(orgContextFor(actor), async (sql) => {
    const row = (await sql.query('SELECT * FROM posture_findings WHERE id=$1', [findingId])).rows[0];
    if (!row) throw Errors.notFound('finding not found');
    const existing = (await sql.query(`SELECT risk_id FROM risk_links WHERE kind='finding' AND ref=$1 LIMIT 1`, [findingId])).rows[0];
    if (existing) throw Errors.conflict(`finding is already covered by risk ${existing.risk_id}`);
    return row;
  });
  const { likelihood, impact } = fromFindingSeverity(f.severity);
  return createRisk(
    actor,
    {
      organizationId: f.organization_id,
      title: f.title,
      description: `Raised from a ${f.severity} posture finding in the ${f.domain} domain.`,
      event: f.title,
      category: 'cybersecurity',
      threatSource: 'adversarial',
      inherentLikelihood: likelihood,
      inherentImpact: impact,
      residualLikelihood: likelihood,
      residualImpact: impact,
      note: 'Raised from posture finding',
    },
    { link: { kind: 'finding', ref: f.id, label: f.title } },
  );
}

// ---------------- Export ----------------

/** POA&M-style CSV of an organization's register. Itself audited: an export is a disclosure. */
export async function exportCsv(actor: Principal, orgId?: string | null): Promise<string> {
  const org = resolveOrg(actor, orgId);
  const rows = await listRisks(actor, org, { includeClosed: true });
  await audit(actor, { action: 'risk.export', organizationId: org, resourceType: 'organization', resourceId: org, detail: { count: rows.length } });
  const headers = [
    'Ref', 'Title', 'Category', 'Status', 'Strategy', 'Owner',
    'Inherent L', 'Inherent I', 'Inherent score', 'Residual L', 'Residual I', 'Residual score', 'Residual rating',
    'Target score', 'Appetite', 'Acceptance', 'Acceptance expires', 'Treatment progress %', 'ALE P50', 'ALE P90',
    'Next review', 'Created', 'Tags',
  ];
  return toCsv(headers, rows.map((r: any) => [
    r.ref, r.title, r.category, r.status, r.strategy, r.owner?.name ?? r.owner_name,
    r.inherent_likelihood, r.inherent_impact, r.inherent_score, r.residual_likelihood, r.residual_impact, r.residual_score, r.residual_rating,
    r.target_score, r.appetite_state, r.acceptance_status, r.acceptance_expires_at, r.treatment_progress, r.fair_results?.p50, r.fair_results?.p90,
    r.next_review_at, r.created_at, r.tags,
  ]));
}

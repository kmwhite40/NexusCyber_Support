// CSAT satisfaction surveys (JSM-style). A survey is created on ticket.resolved; the
// requester rates 1-5, written back to tickets.satisfaction_score for analytics.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { audit } from './audit.js';
import { publish, subscribe, type DomainEvent } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

/**
 * The three questions, in the order they are asked and stored.
 *
 * `overall` is deliberately first and deliberately named: it is the value that flows to
 * tickets.satisfaction_score and therefore into every report that already exists — the csat field
 * in operationalKpis, the per-agent avgRating in analytics.overview. The other two are new and
 * sit beside it; nothing downstream had to change to keep working.
 */
export const SURVEY_QUESTIONS = [
  { key: 'overall', label: 'Overall, how satisfied are you with how this was resolved?' },
  { key: 'timeliness', label: 'How satisfied are you with how quickly it was handled?' },
  { key: 'technician', label: "How would you rate the technician's knowledge and communication?" },
] as const;

export type SurveyQuestionKey = (typeof SURVEY_QUESTIONS)[number]['key'];

/** How long a survey link stays live. Long enough to survive a holiday, short enough that it is
 *  not a standing credential — and ratings stop being useful long after the fact anyway. */
export const SURVEY_TTL_DAYS = 30;

/**
 * Mints a public response token and the hash to store.
 *
 * The token answers a survey on the requester's behalf with NO login, so it is a credential and
 * is treated like one: 256 bits of entropy, and only its SHA-256 goes to the database. A read of
 * that table — a backup, a support export, a replica someone got at — yields no working links.
 * The raw value exists exactly twice: in memory while the invite is composed, and in the
 * recipient's mailbox.
 *
 * A hash, not an HMAC: the stored value is a lookup key for a random 256-bit secret, not a
 * verifier for attacker-chosen input, so there is nothing for a keyed construction to buy here.
 */
export function issueSurveyToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSurveyToken(token) };
}

export function hashSurveyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Can this survey still be answered, and if not, why?
 *
 * Three states are indistinguishable to someone who just clicked a link in an email, and telling
 * them apart is the difference between "this is broken" and "your rating already landed".
 * Answered beats expired: someone whose stale link was also already used wants to hear the
 * useful half.
 *
 * A row with NO expiry is treated as expired. Surveys created before expiries existed are old,
 * not eternal, and failing open on a missing value would make every one of them a permanent
 * unauthenticated write.
 */
export function surveyIsAnswerable(
  s: { responded_at: Date | string | null; expires_at: Date | string | null },
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: 'answered' | 'expired' } {
  if (s.responded_at) return { ok: false, reason: 'answered' };
  if (!s.expires_at || new Date(s.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/** Is a CSAT score a valid 1-5 integer? Pure. */
export function isValidScore(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5;
}

/** Idempotently create a survey for a resolved ticket (called by the event handler). */
export async function createSurveyForTicket(orgId: string, ticketId: string): Promise<void> {
  const { token, tokenHash } = issueSurveyToken();
  const expiresAt = new Date(Date.now() + SURVEY_TTL_DAYS * 86_400_000);
  const created = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO csat_surveys (organization_id, ticket_id, token, token_hash, expires_at, agent_id)
       SELECT $1, $2, $3, $4, $5, t.assigned_agent_id FROM tickets t WHERE t.id = $2
       ON CONFLICT (ticket_id) DO NOTHING RETURNING id`,
      // `token` is the legacy NOT NULL UNIQUE column. It is no longer read by anything — the
      // public link is checked against token_hash — so it gets a value nobody can use as a link.
      [orgId, ticketId, randomUUID(), tokenHash, expiresAt],
    );
    return rows[0]?.id as string | undefined;
  });
  // Email the requester an invite only on first creation, so repeated
  // ticket.resolved events never re-send the survey.
  if (created) {
    // The raw token rides on the event because it is nowhere else — the database holds only its
    // hash, and the template needs a working link. The bus is in-process, and the dispatcher
    // records recipient and status only, never the rendered body.
    publish('csat.survey_created', orgId, {
      ticket_id: ticketId, org_id: orgId, survey_id: created, survey_token: token,
    });
  }
}

/**
 * Reads a survey by its public token, for someone who is not signed in.
 *
 * Runs in SYSTEM context by necessity: the caller has no principal and therefore no org, so
 * there is no RLS context to run under. The token is what stands in for authorization, which is
 * why it carries 256 bits and why only its hash is stored — and why this returns the bare
 * minimum. A survey link may be forwarded, sit in a shared mailbox, or be pasted into a ticket;
 * whoever ends up holding it learns the ticket NUMBER and nothing else. Not the subject, not the
 * requester, not the organisation.
 */
export async function publicSurveyByToken(token: string): Promise<{
  state: 'ok' | 'answered' | 'expired' | 'unknown';
  ticketNumber?: string;
  questions?: typeof SURVEY_QUESTIONS;
}> {
  if (typeof token !== 'string' || token.length < 20) return { state: 'unknown' };
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT s.responded_at, s.expires_at, t.ticket_number
         FROM csat_surveys s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.token_hash = $1`,
      [hashSurveyToken(token)],
    );
    const row = rows[0];
    // A token that matches nothing and a token that matches something are answered identically
    // in shape, so a prober learns only "no" — never "close".
    if (!row) return { state: 'unknown' as const };
    const answerable = surveyIsAnswerable(row);
    if (!answerable.ok) return { state: answerable.reason, ticketNumber: row.ticket_number };
    return { state: 'ok' as const, ticketNumber: row.ticket_number, questions: SURVEY_QUESTIONS };
  });
}

/**
 * Records a response submitted through the public link.
 *
 * There is no Principal here and one is NOT synthesized: the audit log is hash-chained and an
 * invented actor writes a false claim about who did what into a record whose value is that it
 * cannot be argued with. The token is the authorization, the survey row is the subject, and the
 * event carries the rest.
 */
export async function respondPublic(
  token: string,
  scores: { overall: number; timeliness: number; technician: number },
  comment?: string,
): Promise<{ state: 'ok' | 'answered' | 'expired' | 'unknown' }> {
  for (const [key, v] of Object.entries(scores)) {
    if (!isValidScore(v)) throw Errors.badRequest(`${key} must be an integer from 1 to 5`);
  }
  if (comment != null && (typeof comment !== 'string' || comment.length > 2000)) {
    throw Errors.badRequest('comment must be text of at most 2000 characters');
  }
  if (typeof token !== 'string' || token.length < 20) return { state: 'unknown' };
  const result = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT id, organization_id, ticket_id, responded_at, expires_at FROM csat_surveys WHERE token_hash = $1',
      [hashSurveyToken(token)],
    );
    const survey = rows[0];
    if (!survey) return { state: 'unknown' as const };
    const answerable = surveyIsAnswerable(survey);
    if (!answerable.ok) return { state: answerable.reason };
    // `responded_at IS NULL` in the UPDATE, not just the check above: two clicks on the same link
    // arriving together would both pass a read-then-write, and the second would overwrite a
    // rating the customer already gave.
    const { rowCount } = await sql.query(
      `UPDATE csat_surveys
          SET score=$1, score_timeliness=$2, score_technician=$3, comment=$4, responded_at=now()
        WHERE id=$5 AND responded_at IS NULL`,
      [scores.overall, scores.timeliness, scores.technician, comment ?? null, survey.id],
    );
    if (!rowCount) return { state: 'answered' as const };
    await sql.query('UPDATE tickets SET satisfaction_score=$1 WHERE id=$2', [scores.overall, survey.ticket_id]);
    return {
      state: 'ok' as const,
      organizationId: survey.organization_id as string,
      surveyId: survey.id as string,
      ticketId: survey.ticket_id as string,
    };
  });
  if (result.state === 'ok' && 'organizationId' in result) {
    publish('csat.responded', result.organizationId, {
      survey_id: result.surveyId, ticket_id: result.ticketId, score: scores.overall,
    });
  }
  return { state: result.state };
}

let registered = false;
/** Subscribe to ticket.resolved to issue a CSAT survey. */
export function registerCsatHandlers(): void {
  if (registered) return;
  registered = true;
  subscribe('ticket.resolved', async (evt: DomainEvent) => {
    const data = evt.data as { ticket_id?: string; org_id?: string };
    if (data.ticket_id && evt.organization_id) {
      await createSurveyForTicket(evt.organization_id, data.ticket_id);
    }
  });
}

/** Pending (unanswered) surveys visible to the principal (their org / assigned orgs). */
export async function pending(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT s.id, s.ticket_id, s.sent_at, t.ticket_number, t.subject, t.requester_id
         FROM csat_surveys s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.responded_at IS NULL
        ORDER BY s.sent_at DESC`,
    );
    // End users only see surveys for tickets they requested; org-wide readers see all.
    const orgWide = actor.permissions.includes('ticket.read.organization');
    return rows.filter((r) => actor.plane === 'nexus' || orgWide || r.requester_id === actor.id);
  });
}

/** Submit a CSAT score; writes back to tickets.satisfaction_score. */
export async function respond(actor: Principal, surveyId: string, score: number, comment?: string) {
  if (!isValidScore(score)) throw Errors.badRequest('score must be an integer from 1 to 5');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const survey = (await sql.query('SELECT * FROM csat_surveys WHERE id=$1', [surveyId])).rows[0];
    if (!survey) throw Errors.notFound('survey not found');
    if (survey.responded_at) throw Errors.conflict('survey already answered');
    const ticket = (await sql.query('SELECT requester_id, organization_id FROM tickets WHERE id=$1', [survey.ticket_id])).rows[0];
    // Only the requester (or a nexus agent acting on their behalf) may respond.
    if (actor.plane === 'customer' && ticket.requester_id && ticket.requester_id !== actor.id) {
      throw Errors.forbidden('only the requester can rate this ticket');
    }
    await sql.query('UPDATE csat_surveys SET score=$1, comment=$2, responded_at=now() WHERE id=$3', [score, comment ?? null, surveyId]);
    await sql.query('UPDATE tickets SET satisfaction_score=$1 WHERE id=$2', [score, survey.ticket_id]);
    await audit(actor, { action: 'csat.respond', organizationId: survey.organization_id, resourceType: 'csat_survey', resourceId: surveyId, detail: { score } });
    publish('csat.responded', survey.organization_id, { survey_id: surveyId, ticket_id: survey.ticket_id, score });
    return { score };
  });
}

/** Whether the actor can rate a ticket, and whether they already did. Drives the
 *  in-ticket "rate your experience" prompt for resolved/closed tickets. */
export async function ticketSurveyState(
  actor: Principal,
  ticketId: string,
): Promise<{ ratable: boolean; rated: boolean; score: number | null }> {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT requester_id, status, satisfaction_score FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) return { ratable: false, rated: false, score: null };
    const isRequester = actor.plane !== 'customer' || !t.requester_id || t.requester_id === actor.id;
    const resolved = t.status === 'resolved' || t.status === 'closed';
    const survey = (await sql.query('SELECT score, responded_at FROM csat_surveys WHERE ticket_id=$1', [ticketId])).rows[0];
    const rated = !!survey?.responded_at || t.satisfaction_score != null;
    return { ratable: isRequester && resolved, rated, score: survey?.score ?? t.satisfaction_score ?? null };
  });
}

/** Rate a ticket directly (find-or-create its survey). Lets the requester rate any
 *  resolved/closed ticket even if no survey was pre-created at resolve time. */
export async function respondByTicket(actor: Principal, ticketId: string, score: number, comment?: string) {
  if (!isValidScore(score)) throw Errors.badRequest('score must be an integer from 1 to 5');
  // Ensure a survey row exists (system context bypasses RLS for the insert), after
  // validating the actor may rate this ticket and that it is resolved/closed.
  const surveyId = await withSystemContext(async (sql) => {
    const t = (await sql.query('SELECT requester_id, organization_id, status FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    if (actor.plane === 'customer' && t.requester_id && t.requester_id !== actor.id) {
      throw Errors.forbidden('only the requester can rate this ticket');
    }
    if (t.status !== 'resolved' && t.status !== 'closed') throw Errors.badRequest('ticket is not resolved yet');
    const existing = (await sql.query('SELECT id FROM csat_surveys WHERE ticket_id=$1', [ticketId])).rows[0];
    if (existing) return existing.id as string;
    // No token_hash: this row is created BY someone already signed in and rating in the portal,
    // so it never needs a public link. Minting one here would put a live credential in the
    // database for a survey nobody is going to be emailed.
    const inserted = (await sql.query(
      `INSERT INTO csat_surveys (organization_id, ticket_id, token, agent_id)
       SELECT $1, $2, $3, tk.assigned_agent_id FROM tickets tk WHERE tk.id = $2
       ON CONFLICT (ticket_id) DO NOTHING RETURNING id`,
      [t.organization_id, ticketId, randomUUID()],
    )).rows[0]?.id as string | undefined;
    return inserted ?? (await sql.query('SELECT id FROM csat_surveys WHERE ticket_id=$1', [ticketId])).rows[0].id as string;
  });
  // Record via the existing respond path (org context + requester/answered checks).
  return respond(actor, surveyId, score, comment);
}

export interface SurveyRow {
  score: number | null;
  score_timeliness: number | null;
  score_technician: number | null;
  responded_at: Date | string | null;
}

/** Mean of the values that exist, or null when none do. Pure. */
function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  if (!present.length) return null;
  return Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 100) / 100;
}

/**
 * Response rate and a mean per question. Pure.
 *
 * Each question averages over the answers it actually has, not over the responses: a survey
 * answered before the extra questions existed carries only an overall score, and dropping it for
 * lacking the other two would quietly discard most of the history.
 *
 * An average over nothing is NULL, never 0. Zero is the worst rating on this scale, so a dashboard
 * showing it reads as "our customers hate us" when the truth is "nobody has answered yet" — the
 * same failure the posture summary had, where an unmeasured control scored the same as a failed one.
 */
export function summarizeSurveys(rows: SurveyRow[]) {
  const responded = rows.filter((r) => r.responded_at);
  return {
    sent: rows.length,
    responded: responded.length,
    response_rate_pct: rows.length ? Math.round((responded.length / rows.length) * 100) : 0,
    avg_overall: mean(responded.map((r) => r.score)),
    avg_timeliness: mean(responded.map((r) => r.score_timeliness)),
    avg_technician: mean(responded.map((r) => r.score_technician)),
  };
}

export interface AgentSurveyRow extends SurveyRow {
  agent_id: string | null;
  agent_name: string | null;
}

/**
 * Per-technician CSAT, grouped by the agent FROZEN on the survey at resolve time. Pure.
 *
 * Deliberately not tickets.assigned_agent_id. That column is mutable and has no history table, so
 * attributing a rating to whoever holds the ticket today means reassigning an old ticket silently
 * rewrites someone's past performance — in both directions. A performance number that changes
 * retroactively because of an unrelated admin action is worse than no number.
 *
 * Surveys with nobody attributed are LEFT OUT rather than bucketed together: a synthetic "unknown"
 * technician would appear in the ranking as though they were a person.
 */
export function csatByAgent(rows: AgentSurveyRow[]) {
  const byAgent = new Map<string, AgentSurveyRow[]>();
  for (const r of rows) {
    if (!r.agent_id) continue;
    const list = byAgent.get(r.agent_id) ?? [];
    list.push(r);
    byAgent.set(r.agent_id, list);
  }
  return [...byAgent.entries()]
    .map(([agentId, list]) => ({
      agentId,
      name: list.find((r) => r.agent_name)?.agent_name ?? agentId,
      ...summarizeSurveys(list),
    }))
    // Best first, so it reads as a leaderboard. An agent with no responses yet sorts last rather
    // than top, which is what `?? -1` is doing.
    .sort((a, b) => (b.avg_overall ?? -1) - (a.avg_overall ?? -1));
}

/**
 * CSAT for the principal's scope: overall rate and per-question means, plus a per-technician
 * breakdown. The aggregation is the pure functions above, so the reporting rules are testable
 * without a database.
 */
export async function metrics(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT s.score, s.score_timeliness, s.score_technician, s.responded_at,
              s.agent_id, u.display_name AS agent_name
         FROM csat_surveys s
         LEFT JOIN users u ON u.id = s.agent_id`,
    );
    return { ...summarizeSurveys(rows), questions: SURVEY_QUESTIONS, agents: csatByAgent(rows) };
  });
}

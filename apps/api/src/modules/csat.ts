// CSAT satisfaction surveys (JSM-style). A survey is created on ticket.resolved; the
// requester rates 1-5, written back to tickets.satisfaction_score for analytics.
import { randomUUID } from 'node:crypto';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { audit } from './audit.js';
import { publish, subscribe, type DomainEvent } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

/** Is a CSAT score a valid 1-5 integer? Pure. */
export function isValidScore(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5;
}

/** Idempotently create a survey for a resolved ticket (called by the event handler). */
export async function createSurveyForTicket(orgId: string, ticketId: string): Promise<void> {
  const surveyId = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO csat_surveys (organization_id, ticket_id, token) VALUES ($1,$2,$3)
       ON CONFLICT (ticket_id) DO NOTHING RETURNING id`,
      [orgId, ticketId, randomUUID()],
    );
    return rows[0]?.id as string | undefined;
  });
  // Email the requester an invite only on first creation, so repeated
  // ticket.resolved events never re-send the survey.
  if (surveyId) {
    publish('csat.survey_created', orgId, { ticket_id: ticketId, org_id: orgId, survey_id: surveyId });
  }
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
    const inserted = (await sql.query(
      `INSERT INTO csat_surveys (organization_id, ticket_id, token) VALUES ($1,$2,$3)
       ON CONFLICT (ticket_id) DO NOTHING RETURNING id`,
      [t.organization_id, ticketId, randomUUID()],
    )).rows[0]?.id as string | undefined;
    return inserted ?? (await sql.query('SELECT id FROM csat_surveys WHERE ticket_id=$1', [ticketId])).rows[0].id as string;
  });
  // Record via the existing respond path (org context + requester/answered checks).
  return respond(actor, surveyId, score, comment);
}

/** CSAT metrics: response rate and average score for the principal's scope. */
export async function metrics(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT count(*)::int AS sent,
              count(*) FILTER (WHERE responded_at IS NOT NULL)::int AS responded,
              coalesce(round(avg(score) FILTER (WHERE score IS NOT NULL)::numeric, 2), 0) AS avg_score
         FROM csat_surveys`,
    );
    const r = rows[0];
    return {
      sent: r.sent,
      responded: r.responded,
      response_rate_pct: r.sent > 0 ? Math.round((r.responded / r.sent) * 100) : 0,
      avg_score: Number(r.avg_score),
    };
  });
}

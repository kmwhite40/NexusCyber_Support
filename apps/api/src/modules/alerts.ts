// Operations alerts (Opsgenie-style). triggered -> acknowledged -> resolved, with dedup on
// (org, dedup_key) for open alerts, and escalation into an on-call page and/or ticket.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import * as oncall from './oncall.js';
import * as tickets from './tickets.js';
import type { Principal } from '../types.js';

export type AlertState = 'triggered' | 'acknowledged' | 'resolved';

// Client-facing alert columns (excludes internal: details, acknowledged_by).
const ALERT_COLS = 'id, organization_id, source, dedup_key, severity, state, summary, acknowledged_at, resolved_at, escalated_page_id, escalated_ticket_id, created_at';

const TRANSITIONS: Record<AlertState, AlertState[]> = {
  triggered: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

/** Is an alert state transition allowed? Pure. */
export function canAlertTransition(from: AlertState, to: AlertState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export async function listAlerts(actor: Principal, filter: { state?: string; severity?: string } = {}) {
  authorize(actor, 'alert.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.state) { params.push(filter.state); where.push(`state = $${params.length}`); }
    if (filter.severity) { params.push(filter.severity); where.push(`severity = $${params.length}`); }
    const { rows } = await sql.query(
      `SELECT id, organization_id, source, dedup_key, severity, state, summary,
              acknowledged_at, resolved_at, escalated_page_id, escalated_ticket_id, created_at
         FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY (state='triggered') DESC, created_at DESC LIMIT 200`,
      params,
    );
    return rows;
  });
}

export interface CreateAlertInput { summary: string; severity?: string; source?: string; dedupKey?: string; details?: Record<string, unknown>; organizationId?: string; }

export async function createAlert(actor: Principal, input: CreateAlertInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'alert.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    if (input.dedupKey) {
      const existing = (await sql.query(`SELECT ${ALERT_COLS} FROM alerts WHERE organization_id=$1 AND dedup_key=$2 AND state <> 'resolved' LIMIT 1`, [orgId, input.dedupKey])).rows[0];
      if (existing) return existing;
    }
    const { rows } = await sql.query(
      `INSERT INTO alerts (organization_id, source, dedup_key, severity, summary, details)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ALERT_COLS}`,
      [orgId, input.source ?? 'manual', input.dedupKey ?? null, input.severity ?? 'P3', input.summary, JSON.stringify(input.details ?? {})],
    );
    const alert = rows[0];
    await audit(actor, { action: 'alert.create', organizationId: orgId, resourceType: 'alert', resourceId: alert.id, detail: { severity: alert.severity } });
    publish('alert.created', orgId, { alert_id: alert.id, severity: alert.severity });
    return alert;
  });
}

async function transition(actor: Principal, id: string, to: AlertState, verb: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT id, organization_id, state, acknowledged_by, acknowledged_at, resolved_at, escalated_page_id, escalated_ticket_id FROM alerts WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('alert not found');
    authorize(actor, verb, { organizationId: cur.organization_id });
    if (!canAlertTransition(cur.state as AlertState, to)) throw Errors.conflict(`cannot move alert from ${cur.state} to ${to}`);
    const ackBy = to === 'acknowledged' ? actor.id : cur.acknowledged_by;
    const ackAt = to === 'acknowledged' ? new Date().toISOString() : cur.acknowledged_at;
    const resAt = to === 'resolved' ? new Date().toISOString() : cur.resolved_at;
    const { rows } = await sql.query(
      `UPDATE alerts SET state=$1, acknowledged_by=$2, acknowledged_at=$3, resolved_at=$4 WHERE id=$5 RETURNING ${ALERT_COLS}`,
      [to, ackBy, ackAt, resAt, id],
    );
    await audit(actor, { action: `alert.${to}`, organizationId: cur.organization_id, resourceType: 'alert', resourceId: id });
    return rows[0];
  });
}

export const acknowledgeAlert = (actor: Principal, id: string) => transition(actor, id, 'acknowledged', 'alert.ack');
export const resolveAlert = (actor: Principal, id: string) => transition(actor, id, 'resolved', 'alert.ack');

export async function escalateAlert(actor: Principal, id: string, opts: { toPage?: boolean; toTicket?: boolean } = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT id, organization_id, state, escalated_page_id, escalated_ticket_id, summary, severity FROM alerts WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('alert not found');
    authorize(actor, 'alert.manage', { organizationId: cur.organization_id });
    let pageId = cur.escalated_page_id as string | null;
    let ticketId = cur.escalated_ticket_id as string | null;
    if (opts.toTicket && !ticketId) {
      const t = await tickets.createTicket(actor, { subject: cur.summary, type: 'incident', description: cur.summary, organizationId: cur.organization_id });
      ticketId = t.id;
    }
    if (opts.toPage && !pageId) {
      const pg = await oncall.createPage(actor, { ticketId: ticketId ?? undefined, organizationId: cur.organization_id, severity: cur.severity });
      pageId = pg.id;
    }
    await sql.query('UPDATE alerts SET escalated_page_id=$1, escalated_ticket_id=$2 WHERE id=$3', [pageId, ticketId, id]);
    await audit(actor, { action: 'alert.escalate', organizationId: cur.organization_id, resourceType: 'alert', resourceId: id, detail: { pageId, ticketId } });
    return { id, escalated_page_id: pageId, escalated_ticket_id: ticketId };
  });
}

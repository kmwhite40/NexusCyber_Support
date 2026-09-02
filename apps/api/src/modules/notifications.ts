// Notification dispatcher (docs/nexus/06 §K, ADR-006).
// Resolves recipients from domain context, renders per-event templates, and
// sends via the selected adapter (Graph when configured, console otherwise).
// Per-cloud capability matrix drives channel selection with the fallback chain
// Teams -> Email -> Portal; portal is the universal floor and is always recorded.
import { withSystemContext, withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import type { Principal } from '../types.js';
import { subscribe, type DomainEvent } from '../events/bus.js';
import { logger } from '../logger.js';
import { resolveRecipients } from './notifications-recipients.js';
import { renderTemplate } from './notifications-templates.js';
import { getNotificationAdapter } from '../integrations/m365/runtime.js';
import type { NotificationAdapter, DeliveryResult } from '../integrations/m365/adapter.js';
import { config } from '../config.js';

/** Ticket fields used to render templates. Events carry only ticket_id, so the
 *  dispatcher looks the rest up once and merges it into the template context. */
async function ticketDetails(
  sql: Sql,
  ticketId: string | undefined,
): Promise<{ ticket_number?: string; subject?: string; priority?: string; status?: string; created_at?: string; customer_name?: string }> {
  if (!ticketId) return {};
  const { rows } = await sql.query(
    `SELECT t.ticket_number, t.subject, t.priority, t.status, t.created_at,
            u.display_name AS customer_name
       FROM tickets t LEFT JOIN users u ON u.id = t.requester_id
      WHERE t.id = $1`,
    [ticketId],
  );
  return rows[0] ?? {};
}

/** Change fields used to render CAB templates. Events carry only change_id (plus
 *  whatever the publisher already knew, e.g. vote_deadline/window_start); the dispatcher
 *  looks the title up once. Never selects risk/impact/plan text — templates surface only
 *  the title and id. */
async function changeDetails(sql: Sql, changeId: string | undefined): Promise<{ title?: string }> {
  if (!changeId) return {};
  const { rows } = await sql.query('SELECT title FROM changes WHERE id = $1', [changeId]);
  return rows[0] ?? {};
}

type Channel = 'teams' | 'email' | 'portal';

async function capability(sql: Sql, cloud: string, channel: Channel): Promise<string> {
  const { rows } = await sql.query(
    'SELECT capability_matrix FROM cloud_environments WHERE cloud = $1',
    [cloud],
  );
  const matrix = rows[0]?.capability_matrix ?? {};
  return matrix[channel] ?? 'requires_validation';
}

async function orgCloud(sql: Sql, orgId: string | null): Promise<string> {
  if (!orgId) return 'commercial';
  const { rows } = await sql.query('SELECT cloud FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.cloud ?? 'commercial';
}

async function orgName(sql: Sql, orgId: string | null): Promise<string> {
  if (!orgId) return 'your organization';
  const { rows } = await sql.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.name ?? 'your organization';
}

async function record(
  sql: Sql,
  orgId: string | null,
  eventType: string,
  channel: Channel,
  recipient: string | null,
  status: string,
  substitutionReason?: string | null,
  providerMessageId?: string | null,
  attempts = 1,
): Promise<void> {
  await sql.query(
    `INSERT INTO notification_deliveries
       (organization_id, event_type, channel, recipient, status, substitution_reason, provider_message_id, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orgId, eventType, channel, recipient, status, substitutionReason ?? null, providerMessageId ?? null, attempts],
  );
}

// Transient send failures (Graph 429/5xx, blips) are common; retry a couple of times
// with a short backoff before recording a failure. Background work, so the small
// delay is acceptable. Overridable for tests via the delays array.
const SEND_RETRY_DELAYS_MS = [400, 1500];
async function sendWithRetry(
  send: () => Promise<DeliveryResult>,
  delays: number[] = SEND_RETRY_DELAYS_MS,
): Promise<DeliveryResult & { attempts: number }> {
  let last: DeliveryResult = { status: 'failed', error: 'not attempted' };
  for (let i = 0; i <= delays.length; i++) {
    last = await send();
    if (last.status === 'sent') return { ...last, attempts: i + 1 };
    if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
  }
  return { ...last, attempts: delays.length + 1 };
}

/**
 * Dispatch one event. `sql` and `adapter` are injected so this is unit-testable.
 * Records the portal floor, then attempts the best supported external channel.
 */
export async function dispatch(
  sql: Sql,
  orgId: string | null,
  evt: DomainEvent,
  adapter: NotificationAdapter,
): Promise<void> {
  const cloud = await orgCloud(sql, orgId);
  const recipients = await resolveRecipients(sql, evt);

  // Portal floor: always recorded (universal in-app channel, docs/nexus/06 §K.1).
  await record(sql, orgId, evt.type, 'portal', null, 'sent');

  const d = evt.data as any;
  // Events carry only an id reference (ticket_id, or subject_id for approvals);
  // look up the ticket so every template has real number/subject/priority/status.
  // Explicit event fields still override.
  const ref = d.ticket_id ?? d.subject_id;
  const t = evt.type.startsWith('ticket.') || evt.type.startsWith('csat.') || evt.type.startsWith('approval.')
    ? await ticketDetails(sql, ref)
    : {};
  // change.* events carry only change_id — look the title up once (never risk/impact/plan
  // text; templates surface only title + id, per the "nothing sensitive" requirement).
  const changeRef = d.change_id as string | undefined;
  const c = evt.type.startsWith('change.') ? await changeDetails(sql, changeRef) : {};
  const tpl = renderTemplate(evt.type, {
    orgName: await orgName(sql, orgId),
    ticketId: ref,
    ticketNumber: d.ticket_number ?? t.ticket_number,
    subject: d.subject ?? t.subject,
    priority: d.priority ?? t.priority,
    status: d.status ?? t.status,
    metric: d.metric,
    severity: d.severity,
    customerName: d.customer_name ?? t.customer_name,
    submittedAt: d.submitted_at ?? (t.created_at ? new Date(t.created_at).toISOString() : undefined),
    visibility: d.visibility,
    commentExcerpt: d.comment_excerpt,
    resolutionCode: d.resolution_code,
    webOrigin: config.webOrigin[0],
    changeId: changeRef,
    changeTitle: c.title,
    voteDeadline: d.vote_deadline,
    windowStart: d.window_start,
  });

  // Purely customer-facing messages must be email-only — never posted to the
  // internal Teams channel via the fallback chain.
  const emailOnly =
    evt.type === 'ticket.acknowledged' || evt.type === 'csat.survey_created' || evt.type.startsWith('approval.');
  const channelOrder: Channel[] = emailOnly ? ['email'] : ['teams', 'email'];
  for (const channel of channelOrder) {
    const cap = await capability(sql, cloud, channel);
    const adapterCan = channel === 'email' ? adapter.capabilities().email : adapter.capabilities().teams;
    if (cap !== 'supported' || !adapterCan) {
      const why = cap !== 'supported' ? `${cap} in ${cloud}` : 'adapter unavailable';
      await record(sql, orgId, evt.type, channel, null, 'substituted', `${channel} ${why}; falling back`);
      continue;
    }
    if (recipients.length === 0) {
      await record(sql, orgId, evt.type, channel, null, 'skipped', 'no recipients');
      continue; // channel is available; record skipped, but let later channels record too
    }
    if (channel === 'teams') {
      // Teams is a single channel post (no per-person addressing): send ONCE (with retry).
      const result = await sendWithRetry(() => adapter.sendTeams({ summary: tpl.subject, text: tpl.text }));
      await record(sql, orgId, evt.type, channel, null, result.status, result.error ?? null, result.providerMessageId, result.attempts);
      if (result.status === 'sent') return; // posted; stop the chain
      continue; // send failed -> fall through to the next channel
    }
    // email: per-recipient addressing, each with transient-failure retry.
    let anySent = false;
    for (const r of recipients) {
      const result = await sendWithRetry(() => adapter.sendEmail({ to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text }));
      await record(sql, orgId, evt.type, channel, r.email, result.status, result.error ?? null, result.providerMessageId, result.attempts);
      if (result.status === 'sent') anySent = true;
    }
    if (anySent) return; // delivered on this channel; stop the chain
    // all sends failed -> fall through to the next channel
  }
}

/** Wire the dispatcher to events that should notify someone. */
export function registerNotificationHandlers(): void {
  const notifying = [
    'ticket.created',
    'ticket.acknowledged',
    'ticket.assigned',
    'ticket.commented',
    'ticket.status_changed',
    'ticket.escalated',
    'ticket.resolved',
    'ticket.closed',
    'ticket.reopened',
    'csat.survey_created',
    'approval.requested',
    'approval.approved',
    'approval.rejected',
    'sla.warning',
    'sla.breached',
    'posture.finding_created',
    'oncall.acknowledgement_required',
    // CAB voting lifecycle (spec 2026-06-25). cab_requested is the important one — without
    // it a board member is never told they have a ballot; vote_overdue is the deadline
    // sweeper's escalation (jobs/cab-deadline-sweeper.ts), notify-only.
    'change.cab_requested',
    'change.vote_cast',
    'change.approved',
    'change.rejected',
    'change.scheduled',
    'change.vote_overdue',
  ];
  for (const type of notifying) {
    subscribe(type, async (evt: DomainEvent) => {
      try {
        const adapter = await getNotificationAdapter();
        await withSystemContext((sql) => dispatch(sql, evt.organization_id, evt, adapter));
      } catch (err) {
        logger.error({ err, type }, 'notification dispatch failed (would DLQ)');
      }
    });
  }
}

// ---- Query API ----

export interface DeliveryFilter {
  channel?: string;
  status?: string;
  eventType?: string;
  limit?: number;
}

/** Delivery-health rollup for observability: totals + breakdowns by status/channel/
 *  event, and recent non-delivered rows. Surfaces silently-dropped notifications
 *  (e.g. 'substituted: <channel> requires_validation', 'skipped: no recipients'). */
export async function deliveryHealth(actor: Principal, days = 7) {
  authorize(actor, 'notifications.read');
  const d = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 90);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const since = `now() - interval '${d} days'`;
    const totals = (await sql.query(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE status='sent')::int AS sent,
         count(*) FILTER (WHERE status='failed')::int AS failed,
         count(*) FILTER (WHERE status='substituted')::int AS substituted,
         count(*) FILTER (WHERE status='skipped')::int AS skipped
       FROM notification_deliveries WHERE created_at >= ${since}`,
    )).rows[0];
    const byStatus = (await sql.query(`SELECT status AS label, count(*)::int AS count FROM notification_deliveries WHERE created_at >= ${since} GROUP BY status ORDER BY 2 DESC`)).rows;
    const byChannel = (await sql.query(`SELECT channel AS label, count(*)::int AS count FROM notification_deliveries WHERE created_at >= ${since} GROUP BY channel ORDER BY 2 DESC`)).rows;
    const byEvent = (await sql.query(`SELECT event_type AS label, count(*)::int AS count FROM notification_deliveries WHERE created_at >= ${since} GROUP BY event_type ORDER BY 2 DESC LIMIT 12`)).rows;
    const recentIssues = (await sql.query(
      `SELECT event_type, channel, recipient, status, substitution_reason, created_at
         FROM notification_deliveries
        WHERE created_at >= ${since} AND status IN ('failed','substituted','skipped')
        ORDER BY created_at DESC LIMIT 25`,
    )).rows;
    const emailSent = byChannel.find((r: any) => r.label === 'email')?.count ?? 0;
    return { days: d, totals, byStatus, byChannel, byEvent, recentIssues, emailSent };
  });
}

export async function listDeliveries(actor: Principal, filter: DeliveryFilter = {}) {
  authorize(actor, 'notifications.read');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.channel) { params.push(filter.channel); where.push(`channel = $${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    if (filter.eventType) { params.push(filter.eventType); where.push(`event_type = $${params.length}`); }
    params.push(Math.min(Math.max(1, Number(filter.limit) || 200), 500));
    const { rows } = await sql.query(
      `SELECT id, event_type, channel, recipient, status, substitution_reason, provider_message_id, created_at
         FROM notification_deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  });
}

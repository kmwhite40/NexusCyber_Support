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
import type { NotificationAdapter } from '../integrations/m365/adapter.js';

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
): Promise<void> {
  await sql.query(
    `INSERT INTO notification_deliveries
       (organization_id, event_type, channel, recipient, status, substitution_reason, provider_message_id, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [orgId, eventType, channel, recipient, status, substitutionReason ?? null, providerMessageId ?? null],
  );
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

  const tpl = renderTemplate(evt.type, {
    orgName: await orgName(sql, orgId),
    ticketNumber: (evt.data as any).ticket_number,
    subject: (evt.data as any).subject,
    metric: (evt.data as any).metric,
    severity: (evt.data as any).severity,
  });

  for (const channel of ['teams', 'email'] as Channel[]) {
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
      // Teams is a single channel post (no per-person addressing): send ONCE.
      const result = await adapter.sendTeams({ summary: tpl.subject, text: tpl.text });
      await record(sql, orgId, evt.type, channel, null, result.status, result.error ?? null, result.providerMessageId);
      if (result.status === 'sent') return; // posted; stop the chain
      continue; // send failed -> fall through to the next channel
    }
    // email: per-recipient addressing
    let anySent = false;
    for (const r of recipients) {
      const result = await adapter.sendEmail({ to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
      await record(sql, orgId, evt.type, channel, r.email, result.status, result.error ?? null, result.providerMessageId);
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
    'ticket.assigned',
    'ticket.status_changed',
    'sla.warning',
    'sla.breached',
    'posture.finding_created',
    'oncall.acknowledgement_required',
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

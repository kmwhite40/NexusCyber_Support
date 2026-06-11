// Notification dispatcher (docs/nexus/06 §K, ADR-006).
// Per-cloud adapter selection + fallback chain (Teams -> Email -> Portal).
// Portal is the universal floor. This reference logs deliveries to the DB and
// substitutes channels when the cloud capability matrix disallows the preferred one.
import { withSystemContext } from '../db/pool.js';
import { subscribe, type DomainEvent } from '../events/bus.js';
import { logger } from '../logger.js';

type Channel = 'teams' | 'email' | 'portal';

async function capability(cloud: string, channel: Channel): Promise<string> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT capability_matrix FROM cloud_environments WHERE cloud = $1',
      [cloud],
    );
    const matrix = rows[0]?.capability_matrix ?? {};
    return matrix[channel] ?? 'requires_validation';
  });
}

async function orgCloud(orgId: string | null): Promise<string> {
  if (!orgId) return 'commercial';
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query('SELECT cloud FROM organizations WHERE id = $1', [orgId]);
    return rows[0]?.cloud ?? 'commercial';
  });
}

async function record(
  orgId: string | null,
  eventType: string,
  channel: Channel,
  status: string,
  substitutionReason?: string,
): Promise<void> {
  await withSystemContext(async (sql) => {
    await sql.query(
      `INSERT INTO notification_deliveries (organization_id, event_type, channel, status, substitution_reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, eventType, channel, status, substitutionReason ?? null],
    );
  });
}

/** Resolve the deliverable channel using the fallback chain for this org's cloud. */
async function dispatch(orgId: string | null, eventType: string): Promise<void> {
  const cloud = await orgCloud(orgId);
  const preferred: Channel[] = ['teams', 'email'];
  for (const channel of preferred) {
    const cap = await capability(cloud, channel);
    if (cap === 'supported') {
      await record(orgId, eventType, channel, 'sent');
      return;
    }
    await record(
      orgId,
      eventType,
      channel,
      'substituted',
      `${channel} ${cap} in ${cloud}; falling back`,
    );
  }
  // Portal is always the floor.
  await record(orgId, eventType, 'portal', 'sent');
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
  ];
  for (const type of notifying) {
    subscribe(type, async (evt: DomainEvent) => {
      try {
        await dispatch(evt.organization_id, evt.type);
      } catch (err) {
        logger.error({ err, type }, 'notification dispatch failed (would DLQ)');
      }
    });
  }
}

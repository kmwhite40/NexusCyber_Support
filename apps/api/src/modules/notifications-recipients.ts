// Resolve who should be notified for an event, from domain context
// (docs/nexus/06 §K.1). One query per event family; per-user email opt-outs are
// filtered inline via notification_preferences. Runs under the caller's Sql
// context (system context for background dispatch).
import type { Sql } from '../db/pool.js';
import type { DomainEvent } from '../events/bus.js';

export interface Recipient {
  userId: string;
  email: string;
}

// Roles that receive org-wide notifications (posture findings, etc.).
const ADMIN_ROLE_KEYS = ['OrgAdmin', 'SecurityContact'];

// Opt-out filter shared by every query: include a user unless they have explicitly
// disabled email.
const NOT_OPTED_OUT =
  `COALESCE((SELECT np.email_enabled FROM notification_preferences np WHERE np.user_id = u.id), true)`;

function dedupe(rows: { user_id: string; email: string }[]): Recipient[] {
  const seen = new Map<string, Recipient>();
  for (const r of rows) {
    if (r.email && !seen.has(r.user_id)) seen.set(r.user_id, { userId: r.user_id, email: r.email });
  }
  return [...seen.values()];
}

export async function resolveRecipients(sql: Sql, evt: DomainEvent): Promise<Recipient[]> {
  const data = evt.data as Record<string, unknown>;
  const type = evt.type;

  if (type.startsWith('ticket.') || type.startsWith('sla.')) {
    const ticketId = (data.ticket_id ?? data.id ?? data.ticketId) as string | undefined;
    if (!ticketId) return [];
    const { rows } = await sql.query(
      `SELECT u.id AS user_id, u.email
         FROM tickets t
         JOIN users u ON u.id = ANY(ARRAY[t.assigned_agent_id, t.requester_id])
        WHERE t.id = $1 AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
      [ticketId],
    );
    return dedupe(rows);
  }

  if (type.startsWith('posture.')) {
    if (!evt.organization_id) return [];
    const keyLiterals = ADMIN_ROLE_KEYS.map((k) => `'${k}'`).join(', ');
    const { rows } = await sql.query(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM users u
         JOIN role_assignments ra ON ra.user_id = u.id
         JOIN roles r ON r.id = ra.role_id
        WHERE u.organization_id = $1 AND r.key = ANY(ARRAY[${keyLiterals}])
          AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
      [evt.organization_id],
    );
    return dedupe(rows);
  }

  if (type.startsWith('oncall.')) {
    // Prefer the specific responder who must act (e.g. acknowledgement_required
    // carries the on-call user's id); only page the whole rotation when just a
    // schedule id is available.
    const responderId = (data.responder ?? data.responder_id ?? data.user_id) as
      | string
      | undefined;
    if (responderId) {
      const { rows } = await sql.query(
        `SELECT u.id AS user_id, u.email
           FROM users u
          WHERE u.id = $1 AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
        [responderId],
      );
      return dedupe(rows);
    }
    const scheduleId = (data.schedule_id ?? data.scheduleId) as string | undefined;
    if (!scheduleId) return [];
    const { rows } = await sql.query(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM oncall_participants p
         JOIN oncall_rotations rot ON rot.id = p.rotation_id
         JOIN users u ON u.id = p.user_id
        WHERE rot.schedule_id = $1 AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
      [scheduleId],
    );
    return dedupe(rows);
  }

  return [];
}

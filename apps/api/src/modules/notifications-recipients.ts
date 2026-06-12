// Resolve who should be notified for an event, from domain context
// (docs/nexus/06 §K.1). One query per event family; per-user email opt-outs are
// filtered inline via notification_preferences. Runs under the caller's Sql
// context (system context for background dispatch).
import type { Sql } from '../db/pool.js';
import type { DomainEvent } from '../events/bus.js';
import { config } from '../config.js';

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

/** Union several recipient lists, de-duplicated by user. */
function mergeRecipients(...lists: Recipient[][]): Recipient[] {
  const seen = new Map<string, Recipient>();
  for (const list of lists) for (const r of list) if (!seen.has(r.userId)) seen.set(r.userId, r);
  return [...seen.values()];
}

/** The ticket's parties (requester, assignee, org) — drives event-aware routing. */
async function ticketParties(
  sql: Sql,
  ticketId: string,
): Promise<{
  requester_id: string | null;
  assigned_agent_id: string | null;
  organization_id: string;
  desk_email: string | null;
} | null> {
  const { rows } = await sql.query(
    `SELECT t.requester_id, t.assigned_agent_id, t.organization_id,
            g.notification_email AS desk_email
       FROM tickets t
       LEFT JOIN assignment_groups g ON g.id = t.assignment_group_id
      WHERE t.id = $1`,
    [ticketId],
  );
  return rows[0] ?? null;
}

/** Resolve specific users by id (assignee, requester) — opt-out filtered. */
async function usersByIds(sql: Sql, ids: (string | null | undefined)[]): Promise<Recipient[]> {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return [];
  const { rows } = await sql.query(
    `SELECT u.id AS user_id, u.email
       FROM users u
      WHERE u.id = ANY($1::uuid[]) AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
    [clean],
  );
  return dedupe(rows);
}

/** Nexus agents covering a customer org (scoped via active role assignment). */
async function coveringAgents(sql: Sql, orgId: string | null): Promise<Recipient[]> {
  if (!orgId) return [];
  const { rows } = await sql.query(
    `SELECT DISTINCT u.id AS user_id, u.email
       FROM users u
       JOIN role_assignments ra ON ra.user_id = u.id
      WHERE u.plane = 'nexus' AND ra.organization_id = $1
        AND (ra.expires_at IS NULL OR ra.expires_at > now())
        AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
    [orgId],
  );
  return dedupe(rows);
}

export async function resolveRecipients(sql: Sql, evt: DomainEvent): Promise<Recipient[]> {
  const data = evt.data as Record<string, unknown>;
  const type = evt.type;

  if (type.startsWith('ticket.') || type.startsWith('sla.')) {
    const ticketId = (data.ticket_id ?? data.id ?? data.ticketId) as string | undefined;
    if (!ticketId) return [];
    const t = await ticketParties(sql, ticketId);
    if (!t) return [];

    // New ticket -> low-noise: if already assigned, the assignee owns it;
    // otherwise notify the team via ONE shared desk mailbox (the owning group's
    // address, else the platform default). Agents also see it in their queue.
    if (type === 'ticket.created') {
      if (t.assigned_agent_id) return usersByIds(sql, [t.assigned_agent_id]);
      const desk = t.desk_email ?? config.notifications.serviceDeskEmail;
      return desk ? [{ userId: `desk:${desk}`, email: desk }] : [];
    }

    // Assignment -> the newly assigned agent only (customer is not notified on
    // assignment, only on the updates below).
    if (type === 'ticket.assigned') {
      const agentId = (data.agent_id as string | undefined) ?? t.assigned_agent_id;
      return usersByIds(sql, [agentId]);
    }

    // Comments -> internal notes stay with the agents; customer-visible replies
    // reach the requester (never expose internal notes to the customer plane).
    if (type === 'ticket.commented') {
      if (data.visibility === 'internal') {
        return mergeRecipients(
          await usersByIds(sql, [t.assigned_agent_id]),
          await coveringAgents(sql, t.organization_id),
        );
      }
      return usersByIds(sql, [t.requester_id, t.assigned_agent_id]);
    }

    // Escalation -> the covering team.
    if (type === 'ticket.escalated') {
      return coveringAgents(sql, t.organization_id);
    }

    // Customer-facing updates -> the requester (customer) plus the assignee.
    if (type === 'ticket.status_changed' || type === 'ticket.resolved') {
      return usersByIds(sql, [t.requester_id, t.assigned_agent_id]);
    }

    // sla.* and any other internal ticket signal -> assignee + covering team.
    return mergeRecipients(
      await usersByIds(sql, [t.assigned_agent_id]),
      await coveringAgents(sql, t.organization_id),
    );
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

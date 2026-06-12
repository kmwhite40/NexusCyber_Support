// Ticket participants / watchers / collaborators + @mention processing (JSM parity).
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type ParticipantRole = 'watcher' | 'collaborator' | 'approver';
const ROLES: ParticipantRole[] = ['watcher', 'collaborator', 'approver'];

export function isValidRole(r: string): r is ParticipantRole {
  return (ROLES as string[]).includes(r);
}

/** Extract unique, lowercased @-mentioned email addresses from text. Pure. */
export function parseMentions(text: string): string[] {
  const matches = text.match(/@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi) ?? [];
  const emails = matches.map((m) => m.slice(1).toLowerCase());
  return [...new Set(emails)];
}

export async function listForTicket(actor: Principal, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT p.user_id, p.role, u.display_name, u.email
         FROM ticket_participants p JOIN users u ON u.id = p.user_id
        WHERE p.ticket_id=$1 ORDER BY p.role, u.display_name`,
      [ticketId],
    );
    return rows;
  });
}

export async function addParticipant(actor: Principal, ticketId: string, userId: string, role: string = 'watcher') {
  if (!isValidRole(role)) throw Errors.badRequest(`invalid participant role: ${role}`);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.comment', { organizationId: t.organization_id });
    const u = (await sql.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2', [userId, t.organization_id])).rows[0];
    if (!u) throw Errors.badRequest('user is not a member of this organization');
    const { rows } = await sql.query(
      `INSERT INTO ticket_participants (organization_id, ticket_id, user_id, role, added_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (ticket_id, user_id) DO UPDATE SET role=EXCLUDED.role RETURNING *`,
      [t.organization_id, ticketId, userId, role, actor.id],
    );
    await audit(actor, { action: 'ticket.participant.add', organizationId: t.organization_id, resourceType: 'ticket', resourceId: ticketId, detail: { user: userId, role } });
    return rows[0];
  });
}

export async function removeParticipant(actor: Principal, ticketId: string, userId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.comment', { organizationId: t.organization_id });
    await sql.query('DELETE FROM ticket_participants WHERE ticket_id=$1 AND user_id=$2', [ticketId, userId]);
    await audit(actor, { action: 'ticket.participant.remove', organizationId: t.organization_id, resourceType: 'ticket', resourceId: ticketId, detail: { user: userId } });
    return { ok: true };
  });
}

/** Process @mentions in a piece of text: add mentioned org users as watchers + notify them. */
export async function processMentions(actor: Principal, ticketId: string, text: string) {
  const emails = parseMentions(text);
  if (emails.length === 0) return { mentioned: [] as string[] };
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.comment', { organizationId: t.organization_id });
    const { rows: users } = await sql.query(
      'SELECT id, email FROM users WHERE lower(email) = ANY($1) AND organization_id=$2',
      [emails, t.organization_id],
    );
    const mentioned: string[] = [];
    for (const u of users) {
      await sql.query(
        `INSERT INTO ticket_participants (organization_id, ticket_id, user_id, role, added_by)
         VALUES ($1,$2,$3,'watcher',$4) ON CONFLICT (ticket_id, user_id) DO NOTHING`,
        [t.organization_id, ticketId, u.id, actor.id],
      );
      publish('ticket.mentioned', t.organization_id, { ticket_id: ticketId, user_id: u.id, by: actor.id });
      mentioned.push(u.email);
    }
    if (mentioned.length) {
      await audit(actor, { action: 'ticket.mention', organizationId: t.organization_id, resourceType: 'ticket', resourceId: ticketId, detail: { mentioned } });
    }
    return { mentioned };
  });
}

// Ticket linking + merge (JSM-style related issues). Directed links are stored once;
// the reverse direction is presented with an inverse label. (docs/nexus/03 §F.7)
import { withOrgContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type LinkType = 'duplicate_of' | 'caused_by' | 'related_to' | 'blocks' | 'child_of' | 'merged_into';

export const LINK_TYPES: LinkType[] = ['duplicate_of', 'caused_by', 'related_to', 'blocks', 'child_of', 'merged_into'];

const INVERSE_LABEL: Record<LinkType, string> = {
  duplicate_of: 'has duplicate',
  caused_by: 'causes',
  related_to: 'related to',
  blocks: 'blocked by',
  child_of: 'parent of',
  merged_into: 'merged from',
};

/** Is the string a known link type? Pure. */
export function isValidLinkType(t: string): t is LinkType {
  return (LINK_TYPES as string[]).includes(t);
}

/** Display label for the reverse direction of a link. Pure. */
export function inverseLabel(t: LinkType): string {
  return INVERSE_LABEL[t];
}

/** Outgoing + incoming links for a ticket, each with the other ticket's number/subject. */
export async function linksForTicket(sql: Sql, ticketId: string) {
  const { rows } = await sql.query(
    `SELECT l.id, l.link_type, l.from_ticket_id, l.to_ticket_id,
            CASE WHEN l.from_ticket_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction,
            CASE WHEN l.from_ticket_id=$1 THEN t_to.ticket_number ELSE t_from.ticket_number END AS other_number,
            CASE WHEN l.from_ticket_id=$1 THEN t_to.subject ELSE t_from.subject END AS other_subject,
            CASE WHEN l.from_ticket_id=$1 THEN l.to_ticket_id ELSE l.from_ticket_id END AS other_id
       FROM ticket_links l
       JOIN tickets t_from ON t_from.id = l.from_ticket_id
       JOIN tickets t_to ON t_to.id = l.to_ticket_id
      WHERE l.from_ticket_id=$1 OR l.to_ticket_id=$1
      ORDER BY l.created_at`,
    [ticketId],
  );
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    // Show the forward label outgoing, the inverse label incoming.
    label: r.direction === 'outgoing' ? (r.link_type as string).replace(/_/g, ' ') : inverseLabel(r.link_type as LinkType),
    link_type: r.link_type,
    other_id: r.other_id,
    other_number: r.other_number,
    other_subject: r.other_subject,
  }));
}

export async function createLink(actor: Principal, fromId: string, toId: string, type: string) {
  if (!isValidLinkType(type)) throw Errors.badRequest(`invalid link type: ${type}`);
  if (fromId === toId) throw Errors.badRequest('cannot link a ticket to itself');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const from = (await sql.query('SELECT id, organization_id FROM tickets WHERE id=$1', [fromId])).rows[0];
    const to = (await sql.query('SELECT id, organization_id FROM tickets WHERE id=$1', [toId])).rows[0];
    if (!from || !to) throw Errors.notFound('ticket not found');
    if (from.organization_id !== to.organization_id) throw Errors.badRequest('cannot link tickets across organizations');
    authorize(actor, 'ticket.update', { organizationId: from.organization_id });
    const { rows } = await sql.query(
      `INSERT INTO ticket_links (organization_id, from_ticket_id, to_ticket_id, link_type, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (from_ticket_id, to_ticket_id, link_type) DO NOTHING
       RETURNING *`,
      [from.organization_id, fromId, toId, type, actor.id],
    );
    if (!rows[0]) throw Errors.conflict('link already exists');
    // child_of also sets the parent pointer for tree navigation.
    if (type === 'child_of') await sql.query('UPDATE tickets SET parent_ticket_id=$1 WHERE id=$2', [toId, fromId]);
    await audit(actor, { action: 'ticket.link', organizationId: from.organization_id, resourceType: 'ticket', resourceId: fromId, detail: { to: toId, link_type: type } });
    publish('ticket.linked', from.organization_id, { from_ticket_id: fromId, to_ticket_id: toId, link_type: type });
    return rows[0];
  });
}

export async function removeLink(actor: Principal, linkId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const link = (await sql.query('SELECT * FROM ticket_links WHERE id=$1', [linkId])).rows[0];
    if (!link) throw Errors.notFound('link not found');
    authorize(actor, 'ticket.update', { organizationId: link.organization_id });
    await sql.query('DELETE FROM ticket_links WHERE id=$1', [linkId]);
    if (link.link_type === 'child_of') await sql.query('UPDATE tickets SET parent_ticket_id=NULL WHERE id=$1 AND parent_ticket_id=$2', [link.from_ticket_id, link.to_ticket_id]);
    await audit(actor, { action: 'ticket.unlink', organizationId: link.organization_id, resourceType: 'ticket', resourceId: link.from_ticket_id, detail: { link_id: linkId } });
    return { ok: true };
  });
}

/** Merge `sourceId` into `targetId`: move comments, close the source, record a merged_into link. */
export async function merge(actor: Principal, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw Errors.badRequest('cannot merge a ticket into itself');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const source = (await sql.query('SELECT * FROM tickets WHERE id=$1', [sourceId])).rows[0];
    const target = (await sql.query('SELECT id, organization_id FROM tickets WHERE id=$1', [targetId])).rows[0];
    if (!source || !target) throw Errors.notFound('ticket not found');
    if (source.organization_id !== target.organization_id) throw Errors.badRequest('cannot merge across organizations');
    authorize(actor, 'ticket.update', { organizationId: source.organization_id });
    if (['resolved', 'closed'].includes(source.status)) throw Errors.conflict('source ticket is already resolved/closed');

    // Move comments to the target, record the merge, and close the source.
    await sql.query('UPDATE ticket_comments SET ticket_id=$1 WHERE ticket_id=$2', [targetId, sourceId]);
    await sql.query(
      `INSERT INTO ticket_links (organization_id, from_ticket_id, to_ticket_id, link_type, created_by)
       VALUES ($1,$2,$3,'merged_into',$4) ON CONFLICT DO NOTHING`,
      [source.organization_id, sourceId, targetId, actor.id],
    );
    await sql.query(
      `UPDATE tickets SET status='closed', closed_at=now(), resolution_code='merged' WHERE id=$1`,
      [sourceId],
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'merged',$4)`,
      [source.organization_id, sourceId, actor.id, { into: targetId }],
    );
    await audit(actor, { action: 'ticket.merge', organizationId: source.organization_id, resourceType: 'ticket', resourceId: sourceId, detail: { into: targetId } });
    publish('ticket.merged', source.organization_id, { source_ticket_id: sourceId, target_ticket_id: targetId });
    return { merged: true, into: targetId };
  });
}

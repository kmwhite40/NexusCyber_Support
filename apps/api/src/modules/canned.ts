// Canned responses — reusable reply templates with {{placeholder}} rendering (JSM parity).
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

/** Replace {{key}} tokens with values from `vars`; unknown tokens are left intact. Pure. */
export function applyPlaceholders(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => (key in vars ? vars[key] : match));
}

export async function listCanned(actor: Principal) {
  authorize(actor, 'ticket.comment');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT id, name, body, tags FROM canned_responses ORDER BY name');
    return rows;
  });
}

export async function createCanned(actor: Principal, input: { name: string; body: string; tags?: string[] }) {
  authorize(actor, 'ticket.update');
  const orgId = actor.plane === 'customer' ? actor.organizationId : null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO canned_responses (organization_id, name, body, tags, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.name, input.body, input.tags ?? [], actor.id],
    );
    await audit(actor, { action: 'canned_response.create', organizationId: orgId, resourceType: 'canned_response', resourceId: rows[0].id });
    return rows[0];
  });
}

/** Render a canned response against a ticket's context (number, requester, agent). */
export async function render(actor: Principal, cannedId: string, ticketId: string) {
  authorize(actor, 'ticket.comment');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const canned = (await sql.query('SELECT body FROM canned_responses WHERE id=$1', [cannedId])).rows[0];
    if (!canned) throw Errors.notFound('canned response not found');
    const t = (
      await sql.query(
        `SELECT t.ticket_number, t.subject, ru.display_name AS requester_name, ag.display_name AS agent_name
           FROM tickets t
           LEFT JOIN users ru ON ru.id = t.requester_id
           LEFT JOIN users ag ON ag.id = t.assigned_agent_id
          WHERE t.id=$1`,
        [ticketId],
      )
    ).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    const vars: Record<string, string> = {
      ticket_number: t.ticket_number ?? '',
      subject: t.subject ?? '',
      requester_name: t.requester_name ?? 'there',
      agent_name: t.agent_name ?? actor.displayName ?? 'Support',
    };
    return { body: applyPlaceholders(canned.body, vars) };
  });
}

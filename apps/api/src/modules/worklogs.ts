// Ticket worklogs / time tracking (JSM parity). Agents record minutes spent on a ticket.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

/** Sum worklog minutes. Pure. */
export function sumMinutes(logs: Array<{ minutes: number }>): number {
  return logs.reduce((acc, l) => acc + (l.minutes || 0), 0);
}

/** Human-friendly duration, e.g. 150 -> "2h 30m", 45 -> "45m", 0 -> "0m". Pure. */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

export async function addWorklog(actor: Principal, ticketId: string, minutes: number, note?: string) {
  if (!Number.isInteger(minutes) || minutes <= 0) throw Errors.badRequest('minutes must be a positive integer');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.update', { organizationId: t.organization_id });
    const { rows } = await sql.query(
      `INSERT INTO ticket_worklogs (organization_id, ticket_id, author_id, minutes, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [t.organization_id, ticketId, actor.id, minutes, note ?? null],
    );
    await audit(actor, { action: 'ticket.worklog', organizationId: t.organization_id, resourceType: 'ticket', resourceId: ticketId, detail: { minutes } });
    return rows[0];
  });
}

export async function listForTicket(actor: Principal, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, author_id, minutes, note, logged_at FROM ticket_worklogs WHERE ticket_id=$1 ORDER BY logged_at DESC`,
      [ticketId],
    );
    return { entries: rows, total_minutes: sumMinutes(rows), total_label: formatMinutes(sumMinutes(rows)) };
  });
}

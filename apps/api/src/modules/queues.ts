// Saved agent work queues with SLA-aware sorting (JSM parity). The WHERE-builder and
// ORDER-BY expression are pure so they can be unit-tested without a database.
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export interface QueueDefinition {
  status?: string | string[];
  priority?: string | string[];
  unassigned?: boolean;
  tag?: string;
}

export interface WhereResult {
  clauses: string[];
  params: unknown[];
}

/** Build parameterized WHERE clauses for a queue definition. Pure; params are 1-indexed
 *  starting at `startIdx`. The caller prefixes any base clauses (e.g. org scoping). */
export function buildQueueWhere(def: QueueDefinition, startIdx = 1): WhereResult {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  if (def.status !== undefined) {
    if (Array.isArray(def.status)) { params.push(def.status); clauses.push(`t.status = ANY($${i++})`); }
    else { params.push(def.status); clauses.push(`t.status = $${i++}`); }
  }
  if (def.priority !== undefined) {
    if (Array.isArray(def.priority)) { params.push(def.priority); clauses.push(`t.priority = ANY($${i++})`); }
    else { params.push(def.priority); clauses.push(`t.priority = $${i++}`); }
  }
  if (def.unassigned) clauses.push('t.assigned_agent_id IS NULL');
  if (def.tag !== undefined) { params.push(def.tag); clauses.push(`$${i++} = ANY(t.tags)`); }
  return { clauses, params };
}

/** The ORDER BY expression for a queue's sort mode. Pure. */
export function orderExpression(orderBy: string): string {
  switch (orderBy) {
    case 'priority':
      return `CASE t.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END ASC, t.created_at DESC`;
    case 'created':
      return 't.created_at DESC';
    case 'sla':
    default:
      // Soonest-breaching running SLA first; tickets without an active SLA sort last.
      return 'next_sla_due ASC NULLS LAST, t.created_at DESC';
  }
}

export async function listQueues(actor: Principal) {
  authorize(actor, 'ticket.read.all_assigned_customers');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT id, organization_id, name, definition, order_by FROM queues ORDER BY name');
    return rows;
  });
}

export async function createQueue(actor: Principal, input: { name: string; definition?: QueueDefinition; orderBy?: string }) {
  authorize(actor, 'queue.manage');
  const orgId = actor.plane === 'customer' ? actor.organizationId : null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO queues (organization_id, name, definition, order_by, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.name, JSON.stringify(input.definition ?? {}), input.orderBy ?? 'sla', actor.id],
    );
    await audit(actor, { action: 'queue.create', organizationId: orgId, resourceType: 'queue', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

/** Resolve a queue's tickets, applying its filter and SLA-aware sort. */
export async function queueTickets(actor: Principal, queueId: string, limit = 100) {
  authorize(actor, 'ticket.read.all_assigned_customers');
  const queue = await withSystemContext(async (sql) =>
    (await sql.query('SELECT * FROM queues WHERE id=$1', [queueId])).rows[0],
  );
  if (!queue) throw Errors.notFound('queue not found');

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { clauses, params } = buildQueueWhere(queue.definition as QueueDefinition, 1);
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const order = orderExpression(queue.order_by);
    const { rows } = await sql.query(
      `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.assigned_agent_id, t.created_at,
              (SELECT min(due_at) FROM sla_instances s WHERE s.ticket_id=t.id AND s.state IN ('running','warning')) AS next_sla_due
         FROM tickets t
         ${where}
        ORDER BY ${order}
        LIMIT ${Math.min(limit, 500)}`,
      params,
    );
    return { queue: { id: queue.id, name: queue.name, order_by: queue.order_by }, tickets: rows };
  });
}

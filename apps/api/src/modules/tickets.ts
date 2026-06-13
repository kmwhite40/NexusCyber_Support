// Ticketing domain (docs/nexus/03 §F). Create/list/get/assign/comment/transition,
// with priority derivation, SLA start, events, and audit. All queries run inside the
// principal's RLS org-context, so isolation holds even if app logic has a gap.
import type { Sql } from '../db/pool.js';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { startTicketSla, pauseTicketSlas, resumeTicketSlas } from './sla.js';
import { linksForTicket } from './links.js';
import { resolveTransitions, isTransitionAllowed } from './workflows.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

// Impact x Urgency -> Priority (docs/nexus/03 §F.4)
const PRIORITY_MATRIX: Record<number, Record<number, string>> = {
  1: { 1: 'P1', 2: 'P1', 3: 'P2', 4: 'P3' },
  2: { 1: 'P1', 2: 'P2', 3: 'P2', 4: 'P3' },
  3: { 1: 'P2', 2: 'P2', 3: 'P3', 4: 'P4' },
  4: { 1: 'P3', 2: 'P3', 3: 'P4', 4: 'P4' },
};

export function derivePriority(impact: number, urgency: number): string {
  return PRIORITY_MATRIX[impact]?.[urgency] ?? 'P3';
}

async function nextTicketNumber(sql: Sql, orgId: string): Promise<string> {
  // Serialize per-org number allocation: MAX(number)+1 otherwise races under concurrent
  // creates and collides on the (organization_id, ticket_number) unique key. The lock is
  // transaction-scoped (createTicket runs inside withOrgContext's transaction).
  await sql.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [orgId]);
  const { rows } = await sql.query(
    `SELECT COALESCE(MAX((regexp_replace(ticket_number, '\\D','','g'))::int), 0) + 1 AS n
       FROM tickets WHERE organization_id = $1`,
    [orgId],
  );
  const n = rows[0].n as number;
  const prefix = (
    await sql.query('SELECT left(upper(name),4) AS p FROM organizations WHERE id=$1', [orgId])
  ).rows[0].p;
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

export interface CreateTicketInput {
  type?: string;
  subject: string;
  description?: string;
  impact?: number;
  urgency?: number;
  category?: string;
  serviceId?: string;
  affectedUserId?: string;
  organizationId?: string; // required for nexus-plane agents creating on behalf
  tags?: string[];
}

export async function createTicket(actor: Principal, input: CreateTicketInput) {
  const orgId =
    actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required for agent-created tickets');

  authorize(actor, 'ticket.create', { organizationId: orgId });

  const impact = input.impact ?? 3;
  const urgency = input.urgency ?? 3;
  const priority = derivePriority(impact, urgency);

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const ticketNumber = await nextTicketNumber(sql, orgId);
    const { rows } = await sql.query(
      `INSERT INTO tickets
         (organization_id, ticket_number, type, requester_id, affected_user_id, source_channel,
          subject, description, category, service_id, impact, urgency, priority, status, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new',$14)
       RETURNING *`,
      [
        orgId,
        ticketNumber,
        input.type ?? 'incident',
        actor.plane === 'customer' ? actor.id : null,
        input.affectedUserId ?? (actor.plane === 'customer' ? actor.id : null),
        actor.plane === 'customer' ? 'portal' : 'agent',
        input.subject,
        input.description ?? null,
        input.category ?? null,
        input.serviceId ?? null,
        impact,
        urgency,
        priority,
        input.tags ?? [],
      ],
    );
    const ticket = rows[0];

    const due = await startTicketSla(sql, ticket);
    await sql.query(
      `UPDATE tickets SET response_due_at=$1, resolution_due_at=$2, status='triage' WHERE id=$3`,
      [due.response_due_at, due.resolution_due_at, ticket.id],
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'created',$4)`,
      [orgId, ticket.id, actor.id, { priority, channel: ticket.source_channel }],
    );

    await audit(actor, {
      action: 'ticket.create',
      organizationId: orgId,
      resourceType: 'ticket',
      resourceId: ticket.id,
    });
    publish('ticket.created', orgId, {
      ticket_id: ticket.id,
      org_id: orgId,
      type: ticket.type,
      priority,
      requester_id: ticket.requester_id,
      channel: ticket.source_channel,
    });

    return { ...ticket, response_due_at: due.response_due_at, resolution_due_at: due.resolution_due_at, status: 'triage' };
  });
}

export interface ListFilter {
  status?: string;
  assignee?: string; // 'me' | userId
  priority?: string;
  limit?: number;
  type?: string;
}

export async function listTickets(actor: Principal, filter: ListFilter) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];

    // Customer end users with only read.own see only their own tickets.
    const orgWide = can(actor, 'ticket.read.organization') || can(actor, 'ticket.read.all_assigned_customers');
    if (actor.plane === 'customer' && !orgWide) {
      params.push(actor.id);
      where.push(`requester_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.type) {
      params.push(filter.type);
      where.push(`type = $${params.length}`);
    }
    if (filter.priority) {
      params.push(filter.priority);
      where.push(`priority = $${params.length}`);
    }
    if (filter.assignee) {
      params.push(filter.assignee === 'me' ? actor.id : filter.assignee);
      where.push(`assigned_agent_id = $${params.length}`);
    }
    const limit = Math.min(filter.limit ?? 50, 200);
    const sqlText = `SELECT * FROM tickets ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY created_at DESC LIMIT ${limit}`;
    const { rows } = await sql.query(sqlText, params);
    return rows;
  });
}

export async function getTicket(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT * FROM tickets WHERE id = $1', [id]);
    const ticket = rows[0];
    if (!ticket) throw Errors.notFound('ticket not found'); // RLS already scoped it

    // Object-level authorization (IDOR-safe): read.own restricts to requester.
    const orgWide = can(actor, 'ticket.read.organization') || can(actor, 'ticket.read.all_assigned_customers');
    if (actor.plane === 'customer' && !orgWide && ticket.requester_id !== actor.id) {
      throw Errors.forbidden('not the requester');
    }

    const comments = (
      await sql.query('SELECT * FROM ticket_comments WHERE ticket_id=$1 ORDER BY created_at', [id])
    ).rows.filter((c) => c.visibility === 'customer' || actor.plane === 'nexus');
    const events = (
      await sql.query('SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at', [id])
    ).rows;
    const slas = (await sql.query('SELECT * FROM sla_instances WHERE ticket_id=$1', [id])).rows;
    const tasks = (await sql.query('SELECT * FROM service_request_tasks WHERE ticket_id=$1 ORDER BY position', [id])).rows;
    const approvals = (await sql.query('SELECT * FROM approvals WHERE subject_id=$1', [id])).rows;
    const links = await linksForTicket(sql, id);
    return { ...ticket, comments, events, slas, tasks, approvals, links };
  });
}

/**
 * Escalate = REASSIGN ownership to the target tier group and notify (never CC).
 * Enforces the single-accountable-owner rule (docs/nexus/workflows §1.1): the ticket
 * is transferred to the escalation target's queue; the prior owner is released.
 */
export async function escalate(actor: Principal, id: string, targetGroupName: string, reason?: string) {
  authorize(actor, 'ticket.escalate');
  // Tier groups are global (org-NULL) config — resolve outside tenant RLS.
  const grp = await withSystemContext(async (sql) =>
    (await sql.query("SELECT id, name FROM assignment_groups WHERE name=$1 AND scope='nexus'", [targetGroupName])).rows[0],
  );
  if (!grp) throw Errors.badRequest(`unknown escalation target: ${targetGroupName}`);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id, assignment_group_id, assigned_agent_id, status FROM tickets WHERE id=$1', [id])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');

    await sql.query(
      `UPDATE tickets
          SET assignment_group_id=$1, assigned_agent_id=NULL,
              status = CASE WHEN status IN ('new','triage') THEN 'assigned' ELSE status END
        WHERE id=$2`,
      [grp.id, id],
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'escalated',$4)`,
      [t.organization_id, id, actor.id, { to: grp.name, reason: reason ?? null, reassigned: true, from_agent: t.assigned_agent_id }],
    );
    await audit(actor, { action: 'ticket.escalate', organizationId: t.organization_id, resourceType: 'ticket', resourceId: id, detail: { to: grp.name, reason } });
    publish('ticket.escalated', t.organization_id, { ticket_id: id, org_id: t.organization_id, reason: reason ?? '', to_target: grp.name });
    return (await sql.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
  });
}

export async function addComment(
  actor: Principal,
  id: string,
  body: string,
  visibility: 'customer' | 'internal',
) {
  if (visibility === 'internal') {
    if (actor.plane !== 'nexus') throw Errors.forbidden('internal notes are Nexus-only');
  }
  authorize(actor, visibility === 'internal' ? 'ticket.comment' : 'ticket.comment', { visibility });

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id, requester_id FROM tickets WHERE id=$1', [id])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    if (actor.plane === 'customer') {
      const orgWide = can(actor, 'ticket.read.organization');
      if (!orgWide && t.requester_id !== actor.id) throw Errors.forbidden('not the requester');
    }
    const { rows } = await sql.query(
      `INSERT INTO ticket_comments (organization_id, ticket_id, author_id, visibility, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [t.organization_id, id, actor.id, visibility, body],
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'commented',$4)`,
      [t.organization_id, id, actor.id, { visibility }],
    );
    await audit(actor, { action: 'ticket.comment', organizationId: t.organization_id, resourceType: 'ticket', resourceId: id, detail: { visibility } });
    publish('ticket.commented', t.organization_id, {
      ticket_id: id,
      org_id: t.organization_id,
      visibility,
      comment_excerpt: String(body).slice(0, 600),
    });
    return rows[0];
  });
}

export async function assignTicket(
  actor: Principal,
  id: string,
  assignedAgentId: string | null,
  assignmentGroupId: string | null,
) {
  authorize(actor, 'ticket.assign');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id, status FROM tickets WHERE id=$1', [id])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    const newStatus = t.status === 'triage' || t.status === 'new' ? 'assigned' : t.status;
    const { rows } = await sql.query(
      `UPDATE tickets SET assigned_agent_id=$1, assignment_group_id=$2, status=$3 WHERE id=$4 RETURNING *`,
      [assignedAgentId, assignmentGroupId, newStatus, id],
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'assigned',$4)`,
      [t.organization_id, id, actor.id, { assignedAgentId, assignmentGroupId }],
    );
    await audit(actor, { action: 'ticket.assign', organizationId: t.organization_id, resourceType: 'ticket', resourceId: id });
    publish('ticket.assigned', t.organization_id, { ticket_id: id, org_id: t.organization_id, agent_id: assignedAgentId, group_id: assignmentGroupId });
    return rows[0];
  });
}

// Status-transition rules now live in the configurable workflow engine (workflows.ts);
// DEFAULT_TRANSITIONS there is the built-in fallback. transition() resolves the effective
// map per org + ticket type.

export async function transition(actor: Principal, id: string, to: string, opts: { resolutionCode?: string; closureNotes?: string } = {}) {
  authorize(actor, 'ticket.update');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id, status, type FROM tickets WHERE id=$1', [id])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    // Allowed transitions come from the configured workflow for this org+type, falling back
    // to the built-in default map when none is configured.
    const map = await resolveTransitions(sql, t.organization_id, t.type);
    if (!isTransitionAllowed(map, t.status, to)) throw Errors.conflict(`illegal transition ${t.status} -> ${to}`);

    const sets: string[] = ['status=$2'];
    const params: unknown[] = [id, to];
    if (to === 'resolved') {
      sets.push('resolved_at=now()');
      if (opts.resolutionCode) { params.push(opts.resolutionCode); sets.push(`resolution_code=$${params.length}`); }
      if (opts.closureNotes) { params.push(opts.closureNotes); sets.push(`closure_notes=$${params.length}`); }
      // stop resolution SLA
      await sql.query(`UPDATE sla_instances SET state='met' WHERE ticket_id=$1 AND metric='resolution' AND state NOT IN ('met','breached')`, [id]);
    }
    if (to === 'closed') sets.push('closed_at=now()');

    const { rows } = await sql.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params);

    // SLA clock follows on-hold states: pause when the ticket goes on hold (waiting on
    // the customer/vendor), resume when work restarts. Resolution stop is handled above.
    const ON_HOLD = new Set(['waiting_customer', 'waiting_vendor', 'on_hold']);
    if (ON_HOLD.has(to) && !ON_HOLD.has(t.status)) await pauseTicketSlas(sql, id);
    if (to === 'in_progress' && ON_HOLD.has(t.status)) await resumeTicketSlas(sql, id);

    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'status_changed',$4)`,
      [t.organization_id, id, actor.id, { from: t.status, to }],
    );
    await audit(actor, { action: 'ticket.update', organizationId: t.organization_id, resourceType: 'ticket', resourceId: id, detail: { to } });
    publish('ticket.status_changed', t.organization_id, { ticket_id: id, org_id: t.organization_id, from: t.status, to });
    if (to === 'resolved') publish('ticket.resolved', t.organization_id, { ticket_id: id, org_id: t.organization_id, resolution_code: opts.resolutionCode });
    return rows[0];
  });
}

/** Manually pause a ticket's running SLA clocks (e.g. blocked on a third party). */
export async function pauseSla(actor: Principal, id: string) {
  authorize(actor, 'ticket.update');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [id])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    const paused = await pauseTicketSlas(sql, id);
    await audit(actor, { action: 'ticket.sla.pause', organizationId: t.organization_id, resourceType: 'ticket', resourceId: id, detail: { paused } });
    return { paused };
  });
}

/** Resume a ticket's paused SLA clocks, shifting due dates by the paused duration. */
export async function resumeSla(actor: Principal, id: string) {
  authorize(actor, 'ticket.update');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [id])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    const resumed = await resumeTicketSlas(sql, id);
    await audit(actor, { action: 'ticket.sla.resume', organizationId: t.organization_id, resourceType: 'ticket', resourceId: id, detail: { resumed } });
    return { resumed };
  });
}

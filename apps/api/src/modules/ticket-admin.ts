// Administrative ticket corrections: edit a ticket's own fields (PATCH /tickets/:id) and list /
// validate who it may be reassigned to (GET /tickets/:id/assignees, POST /tickets/:id/assign).
//
// Editing needs ticket.edit (ServiceDeskManager; SuperAdmin via admin.superuser). Reassignment
// keeps the existing ticket.assign verb. Both are staff-plane only, scoped to the ticket's org,
// and leave a ticket_events row plus an audit entry.
import type { Sql } from '../db/pool.js';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { retargetTicketSlas } from './sla.js';
import { derivePriority } from './tickets.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export const SUBJECT_MAX = 300;
export const DESCRIPTION_MAX = 20_000;
export const CATEGORY_MAX = 120;

export interface TicketEditPatch {
  subject?: string;
  description?: string | null;
  category?: string | null;
  impact?: number;
  urgency?: number;
}

export interface EditableTicket {
  status: string;
  subject: string;
  description: string | null;
  category: string | null;
  impact: number | null;
  urgency: number | null;
  priority: string | null;
}

export interface FieldChange { field: string; from: unknown; to: unknown }

export interface EditPlan {
  update: Partial<Record<'subject' | 'description' | 'category' | 'impact' | 'urgency' | 'priority', unknown>>;
  changes: FieldChange[];
  priorityChanged: boolean;
  errors: Array<{ field: string; message: string }>;
}

/** Statuses a ticket can no longer be edited in. Closed is the archived record. */
export const EDIT_LOCKED_STATUSES = new Set(['closed']);

const blankToNull = (v: string | null | undefined) => {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/**
 * Decide what a PATCH changes. Pure: validates, normalises, drops no-op keys, and re-derives
 * priority from impact x urgency exactly as createTicket does. The caller applies `update`.
 */
export function planTicketEdit(ticket: EditableTicket, patch: TicketEditPatch): EditPlan {
  const errors: EditPlan['errors'] = [];
  const update: EditPlan['update'] = {};
  const changes: FieldChange[] = [];
  const set = (field: keyof EditPlan['update'], from: unknown, to: unknown) => {
    if (from === to) return;
    update[field] = to;
    changes.push({ field, from, to });
  };

  if (EDIT_LOCKED_STATUSES.has(ticket.status)) {
    errors.push({ field: 'status', message: `a ${ticket.status} ticket cannot be edited` });
  }

  if (patch.subject !== undefined) {
    const s = (patch.subject ?? '').trim();
    if (!s) errors.push({ field: 'subject', message: 'subject cannot be empty' });
    else if (s.length > SUBJECT_MAX) errors.push({ field: 'subject', message: `subject is limited to ${SUBJECT_MAX} characters` });
    else set('subject', ticket.subject, s);
  }
  if (patch.description !== undefined) {
    const d = blankToNull(patch.description);
    if (d && d.length > DESCRIPTION_MAX) errors.push({ field: 'description', message: `description is limited to ${DESCRIPTION_MAX} characters` });
    else set('description', ticket.description, d);
  }
  if (patch.category !== undefined) {
    const c = blankToNull(patch.category);
    if (c && c.length > CATEGORY_MAX) errors.push({ field: 'category', message: `category is limited to ${CATEGORY_MAX} characters` });
    else set('category', ticket.category, c);
  }

  const level = (field: 'impact' | 'urgency', v: number | undefined) => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v < 1 || v > 4) {
      errors.push({ field, message: `${field} must be 1 (highest) to 4 (lowest)` });
      return undefined;
    }
    return v;
  };
  const impact = level('impact', patch.impact);
  const urgency = level('urgency', patch.urgency);
  if (impact !== undefined) set('impact', ticket.impact, impact);
  if (urgency !== undefined) set('urgency', ticket.urgency, urgency);

  let priorityChanged = false;
  if ('impact' in update || 'urgency' in update) {
    const p = derivePriority(impact ?? ticket.impact ?? 3, urgency ?? ticket.urgency ?? 3);
    if (p !== ticket.priority) {
      set('priority', ticket.priority, p);
      priorityChanged = true;
    }
  }

  return { update, changes, priorityChanged, errors };
}

/** Edit a ticket's own fields. Returns the updated ticket row. */
export async function editTicket(
  actor: Principal,
  id: string,
  patch: TicketEditPatch,
  opts: { reason?: string | null } = {},
) {
  if (actor.plane !== 'nexus') throw Errors.forbidden('tickets are edited by service staff only');
  const reason = opts.reason?.trim() || null;

  return withOrgContext(orgContextFor(actor), async (sql) => {
    // Lock the row so two concurrent edits cannot each plan against the same stale values.
    const t = (
      await sql.query(
        `SELECT organization_id, status, subject, description, category, impact, urgency, priority
           FROM tickets WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.edit', { organizationId: t.organization_id });

    const plan = planTicketEdit(t, patch);
    if (plan.errors.some((e) => e.field === 'status')) throw Errors.conflict(plan.errors[0].message);
    if (plan.errors.length) throw Errors.validation('invalid ticket edit', plan.errors);
    if (!plan.changes.length) throw Errors.badRequest('nothing to change');

    const cols = Object.keys(plan.update);
    const assignments = cols.map((c, i) => `${c}=$${i + 2}`).join(', ');
    await sql.query(`UPDATE tickets SET ${assignments} WHERE id=$1`, [id, ...cols.map((c) => plan.update[c as keyof EditPlan['update']])]);

    let slaRetargeted = 0;
    if (plan.priorityChanged) {
      slaRetargeted = await retargetTicketSlas(sql, { id, organization_id: t.organization_id }, plan.update.priority as string);
    }

    // Long text is recorded as "changed", not copied into the event/audit trail in full.
    const trail = plan.changes.map((c) =>
      c.field === 'description' ? { field: c.field, changed: true } : c,
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'edited',$4)`,
      [t.organization_id, id, actor.id, { changes: trail, reason, sla_retargeted: slaRetargeted }],
    );
    // Inside the transaction on purpose: if the audit write fails, the edit rolls back.
    await audit(actor, {
      action: 'ticket.edit',
      organizationId: t.organization_id,
      resourceType: 'ticket',
      resourceId: id,
      detail: { changes: trail, reason },
    });
    return (await sql.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
  });
}

// ---------------- Reassignment ----------------

export interface AssigneeOption { id: string; display_name: string | null; email: string }
export interface GroupOption { id: string; name: string; scope: string }

/** Active staff who can work tickets in `orgId`: an all-orgs or this-org role that grants
 *  ticket.update (or superuser). Customer-plane users are never assignable. */
async function eligibleAgents(sql: Sql, orgId: string, onlyId?: string): Promise<AssigneeOption[]> {
  const { rows } = await sql.query(
    `SELECT DISTINCT u.id, u.display_name, u.email::text AS email
       FROM users u
       JOIN role_assignments ra ON ra.user_id = u.id
            AND (ra.expires_at IS NULL OR ra.expires_at > now())
            AND (ra.organization_id IS NULL OR ra.organization_id = $1)
       JOIN roles r ON r.id = ra.role_id AND r.plane = 'nexus'
       JOIN role_permissions rp ON rp.role_id = r.id
            AND rp.permission_key IN ('ticket.update', 'admin.superuser')
      WHERE u.plane = 'nexus' AND u.status = 'active'
        AND ($2::uuid IS NULL OR u.id = $2::uuid)
      ORDER BY 2, 3`,
    [orgId, onlyId ?? null],
  );
  return rows;
}

async function eligibleGroups(sql: Sql, orgId: string, onlyId?: string): Promise<GroupOption[]> {
  const { rows } = await sql.query(
    `SELECT id, name, scope FROM assignment_groups
      WHERE (scope = 'nexus' OR organization_id = $1)
        AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY scope, name`,
    [orgId, onlyId ?? null],
  );
  return rows;
}

/** Who this ticket can be reassigned to. Needs ticket.assign in the ticket's org. */
export async function listAssignees(actor: Principal, ticketId: string) {
  const t = await withOrgContext(orgContextFor(actor), async (sql) =>
    (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0],
  );
  if (!t) throw Errors.notFound('ticket not found');
  authorize(actor, 'ticket.assign', { organizationId: t.organization_id });
  // Staff users and global groups are not tenant rows: read them outside tenant RLS.
  return withSystemContext(async (sql) => ({
    agents: await eligibleAgents(sql, t.organization_id),
    groups: await eligibleGroups(sql, t.organization_id),
  }));
}

/** Refuse an assignee who is not staff able to work this org, or a group outside it. */
export async function assertAssignable(orgId: string, agentId: string | null, groupId: string | null): Promise<void> {
  await withSystemContext(async (sql) => {
    if (agentId && !(await eligibleAgents(sql, orgId, agentId)).length) {
      throw Errors.validation('invalid assignee', [{ field: 'assignedAgentId', message: 'not an active agent who can work tickets for this organization' }]);
    }
    if (groupId && !(await eligibleGroups(sql, orgId, groupId)).length) {
      throw Errors.validation('invalid assignee', [{ field: 'assignmentGroupId', message: 'not an assignment group available to this organization' }]);
    }
  });
}

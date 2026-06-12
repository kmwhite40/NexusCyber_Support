// Service catalog & request fulfillment (docs/nexus/workflows/service-desk-workflows.md).
// Creating a request spins up a ticket routed to the owning tier group, with an SLA,
// an ordered fulfillment task-checklist, and an approval gate when required.
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { addBusinessMinutes } from './sla.js';
import { Errors } from '../errors.js';
import { getFormByCatalogKey, validateAgainstForm, mapFormAnswers } from './forms.js';
import type { Principal } from '../types.js';

export async function listCatalog() {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT key, name, category, description, ticket_type, owning_tier, escalates_to,
              requires_approval, approver_hint, default_priority, security_class,
              sla_response_min, sla_resolution_min, fulfillment_steps
         FROM service_catalog_items WHERE active ORDER BY category, name`,
    );
    return rows;
  });
}

export interface CreateRequestInput {
  subject?: string;
  description?: string;
  organizationId?: string; // required for agent-created
  answers?: Record<string, unknown>;
}

export async function createRequest(actor: Principal, key: string, input: CreateRequestInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required for agent-created requests');
  authorize(actor, 'ticket.create', { organizationId: orgId });

  // Catalog item + owning tier group are global config (the tier group is org-NULL).
  // Resolve them via the system context so the lookup is not blocked by tenant RLS,
  // and works identically for customer- and agent-initiated requests.
  const { item, grpId } = await withSystemContext(async (sql) => {
    const it = (await sql.query('SELECT * FROM service_catalog_items WHERE key=$1 AND active', [key])).rows[0];
    if (!it) throw Errors.notFound('catalog item not found');
    const g = (await sql.query("SELECT id FROM assignment_groups WHERE name=$1 AND scope='nexus'", [it.owning_tier])).rows[0];
    return { item: it, grpId: (g?.id as string | undefined) ?? null };
  });

  // If the catalog item has a custom form, validate + route its answers.
  let mapped: import('./forms.js').MappedAnswers | null = null;
  if (item.form_key && input.answers) {
    const form = await getFormByCatalogKey(actor, key);
    if (form) {
      const v = validateAgainstForm(form.fields, input.answers);
      if (!v.ok) throw Errors.validation(v.errors.map((e) => e.message).join('; '));
      mapped = mapFormAnswers(form.fields, input.answers, {
        defaultRequesterId: actor.plane === 'customer' ? actor.id : null,
      });
      // Require on-behalf-of for agents only when the form actually routes a field to
      // the requester (forms like offboarding have no requester field — agent is requester).
      const hasRequesterField = form.fields.some((ff: { maps_to: string | null }) => ff.maps_to === 'requester');
      if (actor.plane === 'nexus' && hasRequesterField && !mapped.requesterId) {
        throw Errors.badRequest('on-behalf-of is required for agent-created requests');
      }
    }
  }

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const prefix = (await sql.query('SELECT left(upper(name),4) AS p FROM organizations WHERE id=$1', [orgId])).rows[0].p;
    const n = (
      await sql.query(
        `SELECT COALESCE(MAX((regexp_replace(ticket_number,'\\D','','g'))::int),0)+1 AS n FROM tickets WHERE organization_id=$1`,
        [orgId],
      )
    ).rows[0].n;
    // Requires approval -> starts 'new' (pending approval). Else routed & owned by the tier.
    const status = item.requires_approval ? 'new' : 'assigned';

    const requesterId = mapped?.requesterId ?? (actor.plane === 'customer' ? actor.id : null);
    const affectedUserId = mapped?.affectedUserId ?? null;
    const customFields = mapped ? { ...mapped.customFields, _form: item.form_key } : {};
    const ticket = (
      await sql.query(
        `INSERT INTO tickets
           (organization_id, ticket_number, type, requester_id, affected_user_id, source_channel,
            subject, description, category, priority, status, assignment_group_id, custom_fields, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          orgId,
          `${prefix}-${String(n).padStart(6, '0')}`,
          item.ticket_type,
          requesterId,
          affectedUserId,
          actor.plane === 'customer' ? 'portal' : 'agent',
          mapped?.subject ?? input.subject ?? item.name,
          mapped?.description ?? input.description ?? null,
          item.key,
          item.default_priority,
          status,
          grpId,
          JSON.stringify(customFields),
          ['service_request', item.security_class],
        ],
      )
    ).rows[0];

    // SLA: response (wall-clock) + resolution (business-hours)
    const now = new Date();
    const respDue = new Date(now.getTime() + item.sla_response_min * 60_000);
    const resDue = addBusinessMinutes(now, item.sla_resolution_min, { coverage: '8x5', tz: 'America/New_York' });
    await sql.query(
      `INSERT INTO sla_instances (organization_id, ticket_id, metric, due_at, state)
       VALUES ($1,$2,'response',$3,'running'),($1,$2,'resolution',$4,'running')`,
      [orgId, ticket.id, respDue, resDue],
    );
    await sql.query('UPDATE tickets SET response_due_at=$1, resolution_due_at=$2 WHERE id=$3', [respDue, resDue, ticket.id]);

    // Fulfillment task-checklist
    const steps = (item.fulfillment_steps ?? []) as Array<{ key: string; label: string; role: string; automatable?: boolean }>;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await sql.query(
        `INSERT INTO service_request_tasks (organization_id, ticket_id, step_key, label, assignee_role, position, automatable)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, ticket.id, s.key, s.label, s.role, i, !!s.automatable],
      );
    }

    if (item.requires_approval) {
      const approval = (
        await sql.query(
          `INSERT INTO approvals (organization_id, subject_type, subject_id, status)
           VALUES ($1,'ticket',$2,'requested') RETURNING id`,
          [orgId, ticket.id],
        )
      ).rows[0];
      const approverIds = mapped?.approverIds ?? [];
      for (let i = 0; i < approverIds.length; i++) {
        await sql.query(
          `INSERT INTO approval_steps (organization_id, approval_id, step_order, approver_id)
           VALUES ($1,$2,$3,$4)`,
          [orgId, approval.id, i, approverIds[i]],
        );
      }
      publish('approval.requested', orgId, { subject_type: 'ticket', subject_id: ticket.id });
    }

    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'created',$4)`,
      [orgId, ticket.id, actor.id, { catalog: item.key, owning_tier: item.owning_tier }],
    );
    await audit(actor, { action: 'service_request.create', organizationId: orgId, resourceType: 'ticket', resourceId: ticket.id, detail: { catalog: item.key } });
    publish('ticket.created', orgId, { ticket_id: ticket.id, org_id: orgId, type: item.ticket_type, priority: item.default_priority, channel: 'catalog' });

    return ticket;
  });
}

/** Complete (or skip) a fulfillment task. Auto-resolves the ticket when all are done. */
export async function completeTask(actor: Principal, ticketId: string, taskId: string, skip = false) {
  authorize(actor, 'ticket.update');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const task = (await sql.query('SELECT * FROM service_request_tasks WHERE id=$1 AND ticket_id=$2', [taskId, ticketId])).rows[0];
    if (!task) throw Errors.notFound('task not found');
    await sql.query(
      `UPDATE service_request_tasks SET status=$1, completed_by=$2, completed_at=now() WHERE id=$3`,
      [skip ? 'skipped' : 'done', actor.id, taskId],
    );
    const remaining = (
      await sql.query("SELECT count(*)::int AS n FROM service_request_tasks WHERE ticket_id=$1 AND status='pending'", [ticketId])
    ).rows[0].n;

    await audit(actor, { action: 'service_request.task', organizationId: task.organization_id, resourceType: 'ticket', resourceId: ticketId, detail: { task: task.step_key, status: skip ? 'skipped' : 'done' } });

    if (remaining === 0) {
      await sql.query(
        `UPDATE tickets SET status='resolved', resolved_at=now(), resolution_code='fulfilled' WHERE id=$1 AND status NOT IN ('resolved','closed')`,
        [ticketId],
      );
      await sql.query(`UPDATE sla_instances SET state='met' WHERE ticket_id=$1 AND metric='resolution' AND state NOT IN ('met','breached')`, [ticketId]);
      publish('ticket.resolved', task.organization_id, { ticket_id: ticketId, org_id: task.organization_id, resolution_code: 'fulfilled' });
    }
    return { remaining };
  });
}

/** Approve (or reject) a pending service request — the approval gate. */
export async function decideApproval(actor: Principal, ticketId: string, approve: boolean) {
  // Customer Org Admin or a Nexus agent with assignment authority may act on approvals.
  if (!can(actor, 'customer.admin.manage_users') && !can(actor, 'ticket.assign')) {
    throw Errors.forbidden('not permitted to approve this request');
  }
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id, status FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    await sql.query(`UPDATE approvals SET status=$1 WHERE subject_id=$2`, [approve ? 'approved' : 'rejected', ticketId]);
    // mark the 'approval' fulfillment task done
    await sql.query(
      `UPDATE service_request_tasks SET status=$1, completed_by=$2, completed_at=now()
        WHERE ticket_id=$3 AND step_key='approval'`,
      [approve ? 'done' : 'skipped', actor.id, ticketId],
    );
    if (approve) {
      await sql.query(`UPDATE tickets SET status='assigned' WHERE id=$1 AND status='new'`, [ticketId]);
      publish('approval.approved', t.organization_id, { subject_id: ticketId, approver: actor.id });
    } else {
      await sql.query(`UPDATE tickets SET status='closed', closed_at=now(), resolution_code='rejected' WHERE id=$1`, [ticketId]);
      publish('approval.rejected', t.organization_id, { subject_id: ticketId, approver: actor.id });
    }
    await audit(actor, { action: approve ? 'approval.approve' : 'approval.reject', organizationId: t.organization_id, resourceType: 'ticket', resourceId: ticketId });
    return { status: approve ? 'approved' : 'rejected' };
  });
}

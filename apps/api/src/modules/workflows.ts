// Configurable ticket workflows (JSM parity). Resolves the allowed status-transition map
// for a ticket type from the DB (org-specific → global → built-in default).
import { withOrgContext, withSystemContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type TransitionMap = Record<string, string[]>;

/** Built-in default transitions — the fallback when no workflow is configured. */
export const DEFAULT_TRANSITIONS: TransitionMap = {
  new: ['triage', 'assigned'],
  triage: ['assigned', 'in_progress'],
  assigned: ['in_progress', 'waiting_customer', 'on_hold'],
  in_progress: ['waiting_customer', 'waiting_vendor', 'on_hold', 'resolved'],
  waiting_customer: ['in_progress', 'resolved'],
  waiting_vendor: ['in_progress'],
  on_hold: ['in_progress'],
  resolved: ['closed', 'reopened'],
  reopened: ['in_progress'],
  closed: [],
};

/** Is a transition allowed by a map? Pure. */
export function isTransitionAllowed(map: TransitionMap, from: string, to: string): boolean {
  return (map[from] ?? []).includes(to);
}

/** Build a transition map from flat workflow_transition rows. Pure. */
export function buildMap(rows: Array<{ from_status: string; to_status: string }>): TransitionMap {
  const map: TransitionMap = {};
  for (const r of rows) {
    (map[r.from_status] ??= []).push(r.to_status);
  }
  return map;
}

/**
 * Resolve the effective transition map for an org + ticket type: prefer an org-specific
 * workflow, then a global one, else the built-in default. Runs in the given sql context.
 */
export async function resolveTransitions(sql: Sql, organizationId: string, ticketType: string): Promise<TransitionMap> {
  const { rows } = await sql.query(
    `SELECT t.from_status, t.to_status
       FROM workflows w JOIN workflow_transitions t ON t.workflow_id = w.id
      WHERE w.ticket_type = $2 AND (w.organization_id = $1 OR w.organization_id IS NULL)
      ORDER BY (w.organization_id IS NOT NULL) DESC`,
    [organizationId, ticketType],
  );
  if (rows.length === 0) return DEFAULT_TRANSITIONS;
  // If an org-specific workflow exists, its rows sort first; restrict to the top workflow by
  // re-querying the winning scope. Simpler: prefer org rows when present.
  const hasOrg = await sql.query(
    'SELECT 1 FROM workflows WHERE ticket_type=$2 AND organization_id=$1 LIMIT 1',
    [organizationId, ticketType],
  );
  if (hasOrg.rows.length) {
    const orgRows = await sql.query(
      `SELECT t.from_status, t.to_status FROM workflows w JOIN workflow_transitions t ON t.workflow_id=w.id
        WHERE w.ticket_type=$2 AND w.organization_id=$1`,
      [organizationId, ticketType],
    );
    return buildMap(orgRows.rows);
  }
  return buildMap(rows);
}

// ---- Management API (Nexus config; reuses automation.author for write) ----

export async function listWorkflows(actor: Principal) {
  authorize(actor, 'ticket.update');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT w.id, w.organization_id, w.ticket_type, w.name,
              (SELECT count(*)::int FROM workflow_transitions t WHERE t.workflow_id=w.id) AS transition_count
         FROM workflows w ORDER BY w.ticket_type, w.organization_id NULLS FIRST`,
    );
    return rows;
  });
}

export async function getWorkflow(actor: Principal, id: string) {
  authorize(actor, 'ticket.update');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const wf = (await sql.query('SELECT * FROM workflows WHERE id=$1', [id])).rows[0];
    if (!wf) throw Errors.notFound('workflow not found');
    const transitions = (await sql.query('SELECT id, from_status, to_status FROM workflow_transitions WHERE workflow_id=$1 ORDER BY from_status', [id])).rows;
    return { ...wf, transitions, map: buildMap(transitions) };
  });
}

export async function createWorkflow(actor: Principal, input: { ticketType: string; name: string; organizationId?: string | null }) {
  authorize(actor, 'automation.author');
  const orgId = actor.plane === 'customer' ? actor.organizationId : input.organizationId ?? null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO workflows (organization_id, ticket_type, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [orgId, input.ticketType, input.name, actor.id],
    );
    await audit(actor, { action: 'workflow.create', organizationId: orgId, resourceType: 'workflow', resourceId: rows[0].id, detail: { ticketType: input.ticketType } });
    return rows[0];
  });
}

export async function addTransition(actor: Principal, workflowId: string, fromStatus: string, toStatus: string) {
  authorize(actor, 'automation.author');
  return withSystemContext(async (sql) => {
    const wf = (await sql.query('SELECT id FROM workflows WHERE id=$1', [workflowId])).rows[0];
    if (!wf) throw Errors.notFound('workflow not found');
    const { rows } = await sql.query(
      `INSERT INTO workflow_transitions (workflow_id, from_status, to_status) VALUES ($1,$2,$3)
       ON CONFLICT (workflow_id, from_status, to_status) DO NOTHING RETURNING *`,
      [workflowId, fromStatus, toStatus],
    );
    await audit(actor, { action: 'workflow.add_transition', resourceType: 'workflow', resourceId: workflowId, detail: { fromStatus, toStatus } });
    return rows[0] ?? { ok: true, existed: true };
  });
}

export async function removeTransition(actor: Principal, workflowId: string, fromStatus: string, toStatus: string) {
  authorize(actor, 'automation.author');
  return withSystemContext(async (sql) => {
    await sql.query('DELETE FROM workflow_transitions WHERE workflow_id=$1 AND from_status=$2 AND to_status=$3', [workflowId, fromStatus, toStatus]);
    await audit(actor, { action: 'workflow.remove_transition', resourceType: 'workflow', resourceId: workflowId, detail: { fromStatus, toStatus } });
    return { ok: true };
  });
}

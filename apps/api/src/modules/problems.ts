// Problem management (ITIL). A problem is the root cause behind recurring incidents.
// Incidents link to a problem (tickets.problem_id); known-error problems carry a workaround.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type ProblemStatus = 'open' | 'investigating' | 'known_error' | 'resolved' | 'closed';

const TRANSITIONS: Record<ProblemStatus, ProblemStatus[]> = {
  open: ['investigating', 'closed'],
  investigating: ['known_error', 'resolved', 'closed'],
  known_error: ['resolved', 'closed'],
  resolved: ['closed', 'investigating'],
  closed: [],
};

/** Is a problem status transition allowed? Pure. */
export function canTransition(from: ProblemStatus, to: ProblemStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface IncidentLike {
  id: string;
  category: string | null;
  subject: string;
}
export interface Cluster {
  key: string;
  count: number;
  ticketIds: string[];
  sampleSubject: string;
}

/**
 * Group incidents into candidate problem clusters by category, returning clusters at or
 * above `minCount`. A simple, deterministic heuristic for "recurring incident" detection. Pure.
 */
export function clusterIncidents(incidents: IncidentLike[], minCount = 3): Cluster[] {
  const byKey = new Map<string, IncidentLike[]>();
  for (const inc of incidents) {
    const key = (inc.category ?? 'uncategorized').toLowerCase();
    const list = byKey.get(key) ?? [];
    list.push(inc);
    byKey.set(key, list);
  }
  const clusters: Cluster[] = [];
  for (const [key, list] of byKey) {
    if (list.length >= minCount) {
      clusters.push({ key, count: list.length, ticketIds: list.map((i) => i.id), sampleSubject: list[0].subject });
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

export interface CreateProblemInput {
  title: string;
  description?: string;
  priority?: string;
  organizationId?: string;
}

export async function createProblem(actor: Principal, input: CreateProblemInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'problem.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO problems (organization_id, title, description, priority, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.title, input.description ?? null, input.priority ?? 'P3', actor.id],
    );
    const problem = rows[0];
    await audit(actor, { action: 'problem.create', organizationId: orgId, resourceType: 'problem', resourceId: problem.id, detail: { title: input.title } });
    publish('problem.created', orgId, { problem_id: problem.id });
    return problem;
  });
}

export async function listProblems(actor: Principal, filter: { status?: string } = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { params.push(filter.status); where.push(`status=$${params.length}`); }
    const { rows } = await sql.query(
      `SELECT p.*, (SELECT count(*)::int FROM tickets t WHERE t.problem_id=p.id) AS incident_count
         FROM problems p ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`,
      params,
    );
    return rows;
  });
}

export async function getProblem(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const problem = (await sql.query('SELECT * FROM problems WHERE id=$1', [id])).rows[0];
    if (!problem) throw Errors.notFound('problem not found');
    const incidents = (await sql.query('SELECT id, ticket_number, subject, status FROM tickets WHERE problem_id=$1 ORDER BY created_at DESC', [id])).rows;
    return { ...problem, incidents };
  });
}

export interface UpdateProblemInput {
  rootCause?: string;
  workaround?: string;
  knownError?: boolean;
  priority?: string;
}

export async function updateProblem(actor: Principal, id: string, input: UpdateProblemInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM problems WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('problem not found');
    authorize(actor, 'problem.manage', { organizationId: cur.organization_id });
    const { rows } = await sql.query(
      `UPDATE problems SET root_cause=$1, workaround=$2, known_error=$3, priority=$4, updated_at=now() WHERE id=$5 RETURNING *`,
      [input.rootCause ?? cur.root_cause, input.workaround ?? cur.workaround, input.knownError ?? cur.known_error, input.priority ?? cur.priority, id],
    );
    await audit(actor, { action: 'problem.update', organizationId: cur.organization_id, resourceType: 'problem', resourceId: id });
    return rows[0];
  });
}

export async function transitionProblem(actor: Principal, id: string, to: ProblemStatus) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM problems WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('problem not found');
    authorize(actor, 'problem.manage', { organizationId: cur.organization_id });
    if (!canTransition(cur.status as ProblemStatus, to)) throw Errors.conflict(`cannot move problem from ${cur.status} to ${to}`);
    const resolvedAt = to === 'resolved' ? new Date().toISOString() : cur.resolved_at;
    await sql.query('UPDATE problems SET status=$1, resolved_at=$2, updated_at=now() WHERE id=$3', [to, resolvedAt, id]);
    await audit(actor, { action: `problem.${to}`, organizationId: cur.organization_id, resourceType: 'problem', resourceId: id });
    return { status: to };
  });
}

/** Link an incident (ticket) to a problem. */
export async function linkIncident(actor: Principal, problemId: string, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const problem = (await sql.query('SELECT id, organization_id FROM problems WHERE id=$1', [problemId])).rows[0];
    if (!problem) throw Errors.notFound('problem not found');
    authorize(actor, 'problem.manage', { organizationId: problem.organization_id });
    const t = (await sql.query('SELECT id, organization_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    if (t.organization_id !== problem.organization_id) throw Errors.badRequest('ticket and problem are in different organizations');
    await sql.query('UPDATE tickets SET problem_id=$1 WHERE id=$2', [problemId, ticketId]);
    await audit(actor, { action: 'problem.link_incident', organizationId: problem.organization_id, resourceType: 'problem', resourceId: problemId, detail: { ticketId } });
    return { ok: true };
  });
}

/** Candidate problems: recurring incident clusters not yet attached to a problem. */
export async function candidates(actor: Principal, orgId?: string) {
  const scopedOrg = actor.plane === 'customer' ? actor.organizationId! : orgId;
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where = scopedOrg ? 'organization_id=$1 AND' : '';
    const params = scopedOrg ? [scopedOrg] : [];
    const { rows } = await sql.query(
      `SELECT id, category, subject FROM tickets
        WHERE ${where} type='incident' AND problem_id IS NULL AND status NOT IN ('closed','resolved')`,
      params,
    );
    return clusterIncidents(rows as IncidentLike[]);
  });
}

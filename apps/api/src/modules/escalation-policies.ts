// Escalation policies (PagerDuty/Opsgenie-style). Ordered steps route to the next responder
// after a delay. Pure step logic is unit-tested; CRUD + resolve use org context.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import * as oncall from './oncall.js';
import type { Principal } from '../types.js';

export type TargetType = 'schedule' | 'user';
export interface Step { order: number; targetType: TargetType; targetId: string; delayMinutes: number; }

/** Validate + normalize step order (1-based, sorted by delay). Pure. Throws on invalid. */
export function validateSteps(input: Array<Omit<Step, 'order'> & { order?: number }>): Step[] {
  if (!Array.isArray(input) || input.length === 0) throw Errors.badRequest('at least one step required');
  for (const s of input) {
    if (s.targetType !== 'schedule' && s.targetType !== 'user') throw Errors.badRequest(`invalid targetType: ${s.targetType}`);
    if (!s.targetId) throw Errors.badRequest('targetId required');
    if (typeof s.delayMinutes !== 'number' || s.delayMinutes < 0) throw Errors.badRequest('delayMinutes must be >= 0');
  }
  return [...input]
    .sort((a, b) => a.delayMinutes - b.delayMinutes)
    .map((s, i) => ({ order: i + 1, targetType: s.targetType, targetId: s.targetId, delayMinutes: s.delayMinutes }));
}

/** The step active at `elapsedMinutes`: the last step whose delayMinutes <= elapsed. Pure. */
export function stepForElapsed(steps: Step[], elapsedMinutes: number): Step {
  const sorted = [...steps].sort((a, b) => a.delayMinutes - b.delayMinutes);
  let active = sorted[0];
  for (const s of sorted) if (s.delayMinutes <= elapsedMinutes) active = s;
  return active;
}

const COLS = 'id, organization_id, name, steps, created_by, created_at, updated_at';

export async function listPolicies(actor: Principal) {
  authorize(actor, 'escalation.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => (await sql.query(`SELECT ${COLS} FROM escalation_policies ORDER BY name`)).rows);
}

export interface SavePolicyInput { name: string; steps: Array<Omit<Step, 'order'> & { order?: number }>; organizationId?: string; }

export async function createPolicy(actor: Principal, input: SavePolicyInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'escalation.manage', { organizationId: orgId });
  const steps = validateSteps(input.steps);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(`INSERT INTO escalation_policies (organization_id, name, steps, created_by) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
      [orgId, input.name, JSON.stringify(steps), actor.id]);
    await audit(actor, { action: 'escalation.create', organizationId: orgId, resourceType: 'escalation_policy', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function updatePolicy(actor: Principal, id: string, input: SavePolicyInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT id, organization_id, name, steps FROM escalation_policies WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('escalation policy not found');
    authorize(actor, 'escalation.manage', { organizationId: cur.organization_id });
    const steps = input.steps ? validateSteps(input.steps) : cur.steps;
    const { rows } = await sql.query(`UPDATE escalation_policies SET name=$1, steps=$2, updated_at=now() WHERE id=$3 RETURNING ${COLS}`,
      [input.name ?? cur.name, JSON.stringify(steps), id]);
    await audit(actor, { action: 'escalation.update', organizationId: cur.organization_id, resourceType: 'escalation_policy', resourceId: id });
    return rows[0];
  });
}

export async function deletePolicy(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT id, organization_id FROM escalation_policies WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('escalation policy not found');
    authorize(actor, 'escalation.manage', { organizationId: cur.organization_id });
    await sql.query('DELETE FROM escalation_policies WHERE id=$1', [id]);
    await audit(actor, { action: 'escalation.delete', organizationId: cur.organization_id, resourceType: 'escalation_policy', resourceId: id });
    return { ok: true };
  });
}

/** Resolve who a given step targets right now: a schedule's current on-call, or the named user. */
export async function resolveStepTarget(actor: Principal, id: string, stepOrder: number) {
  authorize(actor, 'escalation.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const pol = (await sql.query('SELECT id, organization_id, steps FROM escalation_policies WHERE id=$1', [id])).rows[0];
    if (!pol) throw Errors.notFound('escalation policy not found');
    const step = (pol.steps as Step[]).find((s) => s.order === stepOrder);
    if (!step) throw Errors.badRequest('step not found');
    if (step.targetType === 'user') {
      const u = (await sql.query('SELECT id, email, display_name FROM users WHERE id=$1', [step.targetId])).rows[0];
      return { step: step.order, targetType: 'user', responder: u ?? null };
    }
    const schedules = await oncall.listSchedules(actor);
    const sched = (schedules as Array<{ id: string; current?: unknown }>).find((s) => s.id === step.targetId);
    return { step: step.order, targetType: 'schedule', scheduleId: step.targetId, responder: sched?.current ?? null };
  });
}

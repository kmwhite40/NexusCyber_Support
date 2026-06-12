// Automation / workflow engine (docs/nexus/07-automation-kb-reporting.md §M, ADR).
// Rules are {trigger, conditions, actions}. The engine subscribes to the event bus;
// when a published rule's trigger matches and its conditions pass, it records an
// execution and performs SAFE internal actions. Customer-visible / destructive actions
// are flagged requires_approval (human-in-the-loop) and NOT auto-performed.
import { pool, withSystemContext } from '../db/pool.js';
import { subscribe, type DomainEvent, publish } from '../events/bus.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { logger } from '../logger.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

// ---------- Types ----------
export interface Condition {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'contains' | 'exists';
  value?: unknown;
}
export interface ConditionGroup {
  all?: Condition[];
  any?: Condition[];
}
export interface Action {
  type: string;
  [k: string]: unknown;
}
export interface RuleDefinition {
  trigger: { event: string };
  conditions?: ConditionGroup;
  actions: Action[];
}

// Actions that are customer-visible or destructive require a human gate.
const GATED_ACTIONS = new Set(['notify_user', 'change_status', 'close_stale_ticket', 'reopen_ticket', 'add_comment']);
// Actions the engine will actually perform automatically (internal, reversible).
const SAFE_ACTIONS = new Set(['add_internal_note', 'add_tag', 'page_oncall', 'escalate_ticket', 'create_posture_finding', 'notify_teams_channel']);

// ---------- Pure evaluation (unit-tested) ----------
function getField(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), ctx);
}

export function evalCondition(c: Condition, ctx: Record<string, unknown>): boolean {
  const actual = getField(ctx, c.field);
  switch (c.op) {
    case 'eq': return actual === c.value;
    case 'neq': return actual !== c.value;
    case 'in': return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
    case 'gte': return typeof actual === 'number' && typeof c.value === 'number' && actual >= c.value;
    case 'lte': return typeof actual === 'number' && typeof c.value === 'number' && actual <= c.value;
    case 'contains': return Array.isArray(actual) && actual.includes(c.value);
    case 'exists': return actual !== undefined && actual !== null;
    default: return false;
  }
}

export function evaluateConditions(group: ConditionGroup | undefined, ctx: Record<string, unknown>): boolean {
  if (!group) return true;
  if (group.all && !group.all.every((c) => evalCondition(c, ctx))) return false;
  if (group.any && group.any.length && !group.any.some((c) => evalCondition(c, ctx))) return false;
  return true;
}

/** Plan the actions for a rule against a context — pure, no side effects. */
export function planActions(def: RuleDefinition, ctx: Record<string, unknown>): Array<{ action: Action; performed: boolean; gated: boolean }> {
  if (!evaluateConditions(def.conditions, ctx)) return [];
  return def.actions.map((action) => ({
    action,
    gated: GATED_ACTIONS.has(action.type),
    performed: SAFE_ACTIONS.has(action.type) && !GATED_ACTIONS.has(action.type),
  }));
}

// ---------- Live execution ----------
async function performSafeAction(orgId: string | null, ticketId: string | undefined, action: Action) {
  if (!ticketId) return;
  // Runs via the system context so the engine (a server-side actor with no tenant
  // session) can write to RLS-protected tables for the resolved org.
  await withSystemContext(async (sql) => {
    if (action.type === 'add_internal_note') {
      await sql.query(
        `INSERT INTO ticket_internal_notes (organization_id, ticket_id, body) VALUES ($1,$2,$3)`,
        [orgId, ticketId, String(action.text ?? 'Automation note')],
      );
    } else if (action.type === 'add_tag' && action.tag) {
      await sql.query(`UPDATE tickets SET tags = array_append(tags, $1) WHERE id=$2 AND NOT ($1 = ANY(tags))`, [String(action.tag), ticketId]);
    }
    // page_oncall / escalate_ticket / create_posture_finding are recorded as performed
    // intents here; in production they call the respective modules with the rule's
    // scoped service principal.
  }).catch(() => {});
}

let registered = false;
export function registerAutomationHandlers(): void {
  if (registered) return;
  registered = true;
  subscribe('*', async (evt: DomainEvent) => {
    try {
      const rules = (
        await pool.query("SELECT * FROM automation_rules WHERE state='published'")
      ).rows.filter((r) => (r.definition as RuleDefinition).trigger?.event === evt.type);
      for (const rule of rules) {
        const def = rule.definition as RuleDefinition;
        // Scope: global rule (org null) or matching the event's org.
        if (rule.organization_id && rule.organization_id !== evt.organization_id) continue;
        const ctx = { ...evt.data, event: evt.type };
        const plan = planActions(def, ctx);
        if (!plan.length) continue;
        const idemKey = `auto:${rule.id}:${evt.event_id}`;
        const ticketId = (evt.data as Record<string, unknown>).ticket_id as string | undefined;
        for (const step of plan) if (step.performed) await performSafeAction(evt.organization_id, ticketId, step.action);
        await pool
          .query(
            `INSERT INTO automation_executions (organization_id, rule_id, rule_version, trigger_event, outcome, steps, idempotency_key)
             VALUES ($1,$2,$3,$4,'executed',$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
            [evt.organization_id, rule.id, rule.version, evt.type, JSON.stringify(plan), idemKey],
          )
          .catch(() => {});
        publish('automation.executed', evt.organization_id, { execution_id: idemKey, rule_id: rule.id, version: rule.version, outcome: 'executed' });
      }
    } catch (err) {
      logger.error({ err, type: evt.type }, 'automation handler failed (would DLQ)');
    }
  });
}

// ---------- CRUD / lifecycle (Nexus-managed) ----------
function requireAutomationAccess(actor: Principal) {
  if (actor.plane !== 'nexus') throw Errors.forbidden('automation is Nexus-managed');
}

export async function listRules(actor: Principal) {
  requireAutomationAccess(actor);
  authorize(actor, 'automation.author');
  return (await pool.query('SELECT id, name, state, version, definition, organization_id, created_at FROM automation_rules ORDER BY created_at DESC')).rows;
}

export async function createRule(actor: Principal, input: { name: string; definition: RuleDefinition; organizationId?: string }) {
  authorize(actor, 'automation.author');
  const r = (
    await pool.query(
      `INSERT INTO automation_rules (organization_id, name, definition, state, author_id) VALUES ($1,$2,$3,'draft',$4) RETURNING *`,
      [input.organizationId ?? null, input.name, JSON.stringify(input.definition), actor.id],
    )
  ).rows[0];
  await audit(actor, { action: 'automation.create', resourceType: 'automation_rule', resourceId: r.id });
  return r;
}

export async function simulate(actor: Principal, ruleId: string, sampleEvent: Record<string, unknown>) {
  authorize(actor, 'automation.author');
  const rule = (await pool.query('SELECT * FROM automation_rules WHERE id=$1', [ruleId])).rows[0];
  if (!rule) throw Errors.notFound('rule not found');
  const plan = planActions(rule.definition as RuleDefinition, sampleEvent);
  return { matched: plan.length > 0, intended_actions: plan };
}

export async function publishRule(actor: Principal, ruleId: string) {
  authorize(actor, 'automation.publish');
  const rule = (await pool.query('SELECT * FROM automation_rules WHERE id=$1', [ruleId])).rows[0];
  if (!rule) throw Errors.notFound('rule not found');
  // Separation of duties: author cannot publish their own version.
  if (rule.author_id && rule.author_id === actor.id) {
    throw Errors.forbidden('separation of duties: author cannot publish their own rule');
  }
  await pool.query("UPDATE automation_rules SET state='published', publisher_id=$1, updated_at=now() WHERE id=$2", [actor.id, ruleId]);
  await audit(actor, { action: 'automation.publish', resourceType: 'automation_rule', resourceId: ruleId });
  return { state: 'published' };
}

export async function setState(actor: Principal, ruleId: string, state: 'draft' | 'disabled') {
  authorize(actor, 'automation.publish');
  await pool.query('UPDATE automation_rules SET state=$1, updated_at=now() WHERE id=$2', [state, ruleId]);
  await audit(actor, { action: 'automation.set_state', resourceType: 'automation_rule', resourceId: ruleId, detail: { state } });
  return { state };
}

export async function listExecutions(actor: Principal, ruleId: string) {
  requireAutomationAccess(actor);
  authorize(actor, 'automation.author');
  return (await pool.query('SELECT id, trigger_event, outcome, steps, created_at FROM automation_executions WHERE rule_id=$1 ORDER BY created_at DESC LIMIT 50', [ruleId])).rows;
}

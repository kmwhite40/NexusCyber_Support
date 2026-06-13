# Escalation Policies — Implementation Plan (Enterprise increment #1)

> REQUIRED SUB-SKILL: subagent-driven-development.

**Goal:** Add configurable multi-step **escalation policies** (PagerDuty/Opsgenie/ServiceNow parity): an ordered set of steps (notify a schedule's current on-call or a specific user after N minutes), managed via API + UI, with pure step-resolution logic and a resolver that returns the real responder for a step.

**Architecture:** New `escalation_policies` table (org-scoped, RLS like `0014_queues.sql`). Module `escalation-policies.ts` with TWO pure functions (TDD): `validateSteps` and `stepForElapsed`, plus CRUD and `resolveStepTarget` (reuses `oncall.listSchedules` to find a schedule's current on-call; looks up users directly). Routes (requirePrincipal + zod + {data}), client helpers, `/escalation-policies` page, nav entry, integration test. Reuses every established pattern.

**Tech:** Fastify+PG (RLS), Next 14+Tailwind, vitest. No new deps. Permissions: `escalation.read`, `escalation.manage` (seeded + re-seed to apply).

**Collision protocol:** concurrent process active — before editing shared files (`seed.ts`, `routes.ts`, `api.ts`, `shell.tsx`) run `git status --short <file>` (BLOCK if `M`), RE-READ, splice, surgical `git add`. New migration = next free number at creation (`ls migrations|sort|tail -1`; plan assumes 0035). Run integration tests with inline `DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus APP_DATABASE_URL=postgres://nexus_app:nexus_app@localhost:5544/nexus npx vitest run <file>`. Web gate `npx tsc --noEmit`. Do NOT `next build` against the live tree.

---

## Task 1: Permissions
Modify `apps/api/src/db/seed.ts`: add catalog entries `['escalation.read','oncall']`, `['escalation.manage','oncall']` (skip if present). Grant `escalation.read` + `escalation.manage` to `ServiceDeskManager`; `escalation.read` to `Tier2`, `SecurityAnalyst`, `Tier1`. No customer-plane grants. `cd apps/api && npx tsc --noEmit`. Commit `feat(authz): escalation.read/manage permissions`.

## Task 2: Migration (next free number, assume 0035)
Create `apps/api/src/db/migrations/0035_escalation_policies.sql` (verify RLS helpers against `0014_queues.sql`):
```sql
-- Escalation policies: ordered steps that route an unacknowledged page/alert to the next
-- responder after a delay. Steps are jsonb: [{order,targetType,targetId,delayMinutes}].
CREATE TABLE escalation_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  steps           jsonb NOT NULL DEFAULT '[]',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE escalation_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY escalation_policies_isolation ON escalation_policies
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON escalation_policies TO nexus_app;
```
Apply: `cd apps/api && DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus APP_DATABASE_URL=postgres://nexus_app:nexus_app@localhost:5544/nexus npx tsx src/db/migrate.ts | tail -3`. Commit.

## Task 3: Pure logic (TDD) — `escalation-policies.ts`
Create test `apps/api/test/escalation-policies.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateSteps, stepForElapsed } from '../src/modules/escalation-policies.js';

describe('validateSteps', () => {
  it('accepts ordered schedule/user steps and normalizes order', () => {
    const s = validateSteps([{ targetType: 'schedule', targetId: 'a', delayMinutes: 0 }, { targetType: 'user', targetId: 'b', delayMinutes: 15 }]);
    expect(s.map((x) => x.order)).toEqual([1, 2]);
  });
  it('rejects empty steps, bad targetType, negative delay', () => {
    expect(() => validateSteps([])).toThrow();
    expect(() => validateSteps([{ targetType: 'group', targetId: 'x', delayMinutes: 0 } as any])).toThrow();
    expect(() => validateSteps([{ targetType: 'user', targetId: 'x', delayMinutes: -1 }])).toThrow();
  });
});

describe('stepForElapsed', () => {
  const steps = [
    { order: 1, targetType: 'schedule', targetId: 'a', delayMinutes: 0 },
    { order: 2, targetType: 'user', targetId: 'b', delayMinutes: 10 },
    { order: 3, targetType: 'user', targetId: 'c', delayMinutes: 30 },
  ] as any;
  it('returns the active step for elapsed minutes (cumulative >= delay)', () => {
    expect(stepForElapsed(steps, 0).order).toBe(1);
    expect(stepForElapsed(steps, 9).order).toBe(1);
    expect(stepForElapsed(steps, 10).order).toBe(2);
    expect(stepForElapsed(steps, 45).order).toBe(3);
  });
});
```
Run → FAIL. Then create `apps/api/src/modules/escalation-policies.ts`:
```ts
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
```
NOTE: confirm `oncall.listSchedules` returns objects with `id` and a `current` field (it resolves current on-call). If the field name differs, adapt `resolveStepTarget`. Confirm `Errors.badRequest`/`notFound` exist (they do per problems.ts). Run the unit test → PASS. `cd apps/api && npx tsc --noEmit`. Commit.

## Task 4: Routes + client + page + nav
**Routes** (re-read routes.ts; `import * as escalationPolicies from '../modules/escalation-policies.js';`):
```ts
app.get('/api/v1/escalation-policies', async (req) => { const p = await requirePrincipal(req); return { data: await escalationPolicies.listPolicies(p) }; });
app.post('/api/v1/escalation-policies', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ name: z.string().min(1), steps: z.array(z.object({ targetType: z.enum(['schedule','user']), targetId: z.string().min(1), delayMinutes: z.number().min(0) })).min(1), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return escalationPolicies.createPolicy(p, b); });
app.patch('/api/v1/escalation-policies/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ name: z.string().optional(), steps: z.array(z.object({ targetType: z.enum(['schedule','user']), targetId: z.string().min(1), delayMinutes: z.number().min(0) })).optional() }).parse(req.body); return escalationPolicies.updatePolicy(p, id, b as any); });
app.delete('/api/v1/escalation-policies/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return escalationPolicies.deletePolicy(p, id); });
app.get('/api/v1/escalation-policies/:id/resolve', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const { step } = z.object({ step: z.coerce.number().int().min(1) }).parse(req.query); return escalationPolicies.resolveStepTarget(p, id, step); });
```
**Client** (append api.ts):
```ts
export interface EscalationStep { order: number; targetType: 'schedule' | 'user'; targetId: string; delayMinutes: number; }
export interface EscalationPolicy { id: string; organization_id: string; name: string; steps: EscalationStep[]; created_at: string; }
export const escalationApi = {
  list: () => api.get<{ data: EscalationPolicy[] }>('/escalation-policies').then((r) => r.data),
  create: (b: { name: string; steps: { targetType: string; targetId: string; delayMinutes: number }[]; organizationId?: string }) => api.post<EscalationPolicy>('/escalation-policies', b),
  update: (id: string, b: { name?: string; steps?: { targetType: string; targetId: string; delayMinutes: number }[] }) => api.patch<EscalationPolicy>(`/escalation-policies/${id}`, b),
  remove: (id: string) => api.del<{ ok: true }>(`/escalation-policies/${id}`),
};
```
**Page** `apps/web/app/(app)/escalation-policies/page.tsx`: list policies (name + step count + step summary "schedule@0m → user@10m"); `can('escalation.manage')` gates a "New policy" modal (name + repeatable step rows: targetType select, targetId input, delayMinutes input). Reuse Card/CardBody/DataTable/Button/Select/Input/Field/Skeleton/EmptyState + inline-modal pattern; `.catch(()=>setRows([]))`. Org picker for nexus plane (mirror channels/dashboards modals). 
**Nav** (`shell.tsx`): add `{ href: '/escalation-policies', label: 'Escalation', icon: <IconPager />, anyPerm: ['escalation.read','escalation.manage'], section: 'Operations' }` (reuse IconPager) + titleFor case `if (path.startsWith('/escalation-policies')) return 'Escalation policies';`.
Typecheck both. Commit.

## Task 5: Integration test
`apps/api/test/integration/escalation-policies.int.test.ts` (describeDb + principalByEmail pattern): manager creates a policy with two steps → list returns it with normalized `order`; create with empty steps rejects; a customer/EndUser (no escalation.manage) is denied create; `resolveStepTarget` for a 'user' step returns that user. Run against 5544 → PASS.

## Self-Review
- Gap closed: multi-step escalation policy entity + management + step resolution = PagerDuty/Opsgenie/ServiceNow parity for the policy layer. (Auto-timer advancement of live pages is a documented follow-up — this increment delivers the policy model, management UI, validated step logic, and real responder resolution.)
- TDD on `validateSteps` + `stepForElapsed`; integration test covers CRUD + denial + resolve.
- Patterns reused verbatim (RLS, requirePrincipal+zod+{data}, explicit columns, authorize on reads+writes, inline modal, nav section).
- Permissions seeded + re-seed applies them; `escalation.manage` only for ServiceDeskManager (which now has ticket.create etc.).

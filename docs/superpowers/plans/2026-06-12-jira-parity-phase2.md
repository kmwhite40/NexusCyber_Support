# Jira-Parity Phase 2 Implementation Plan (Net-New Subsystems)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three net-new operations subsystems — Alerts (new entity that can escalate to a page/ticket), Channels (intake config), and multiple named Dashboards (preset-widget library) — each with migration + API + client + page + nav.

**Architecture:** Same patterns as Phase 1. API modules in `apps/api/src/modules/*.ts` (`withOrgContext`/`orgContextFor`/`authorize`/`audit`/`publish`/`Errors`); migrations in `apps/api/src/db/migrations/NNNN_*.sql` with RLS mirroring `0014_queues.sql`; inline route registration in `routes.ts` (`const p = await requirePrincipal(req)`, zod-parse, `{data}` envelope); client helpers in `apps/web/lib/api.ts`; `'use client'` pages under `apps/web/app/(app)/<f>/page.tsx`; nav in `shell.tsx`. Pure alert state-transition logic is TDD'd with vitest.

**Tech Stack:** Fastify + Postgres (RLS) API; Next.js 14 + Tailwind web; vitest; npm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-11-jira-parity-features-design.md` (Alerts = new entity can escalate; Dashboards = named + preset widgets).

---

## Collision protocol (concurrent process active)

Another agent commits to this branch and adds migrations frequently (latest is `0021`). For EVERY task:
- Before creating a migration, run `ls apps/api/src/db/migrations | sort | tail -1` and use the **next free number** at that moment. This plan assumes `0022` alerts / `0023` channels / `0024` dashboards — **renumber to the next free slots if taken**, and update the file name only (content unchanged).
- Before editing shared files (`routes.ts`, `api.ts`, `shell.tsx`, `seed.ts`, `analytics.ts`), run `git status --short <file>`; if it shows `M` (concurrent uncommitted edits), STOP that file and report BLOCKED rather than risk sweeping their work. Otherwise RE-READ and splice in.
- Surgical `git add` of only the files each task changes. Never `git add -A`.
- Web gate: `cd apps/web && npx tsc --noEmit`. API gate: `cd apps/api && npx tsc --noEmit` + relevant `npx vitest run`. Do NOT run `next build` (corrupts the live dev `.next`).

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/migrations/0022_alerts.sql` | `alerts` table + RLS |
| `apps/api/src/modules/alerts.ts` | `canAlertTransition` (pure) + ingest/ack/resolve/escalate/list |
| `apps/api/test/alerts.test.ts` | unit tests for `canAlertTransition` |
| `apps/api/src/db/migrations/0023_channels.sql` | `channels` table + RLS |
| `apps/api/src/modules/channels.ts` | channel CRUD |
| `apps/api/src/db/migrations/0024_dashboards.sql` | `dashboards` table + RLS + seed default |
| `apps/api/src/modules/dashboards.ts` | dashboard CRUD + widget catalog |
| `apps/api/src/http/routes.ts` (modify) | register alerts/channels/dashboards routes |
| `apps/api/src/db/seed.ts` (modify) | alert.*/channel.*/dashboard.* perms + grants |
| `apps/web/lib/api.ts` (modify) | client helpers + interfaces |
| `apps/web/app/(app)/alerts/page.tsx` | alert feed + actions |
| `apps/web/app/(app)/channels/page.tsx` | channel config |
| `apps/web/app/(app)/dashboards/page.tsx` | dashboard list + widget render |
| `apps/web/components/shell.tsx` (modify) | nav entries + icons + titleFor |

---

## Task 1: Permission keys + grants

**Files:** Modify `apps/api/src/db/seed.ts`

- [ ] **Step 1: Re-read seed.ts**

Run `git status --short apps/api/src/db/seed.ts` (if `M`, BLOCK). Then `grep -n "queue.manage\|service.manage\|perms:" apps/api/src/db/seed.ts` to locate the catalog array and role blocks.

- [ ] **Step 2: Add catalog entries** (skip any already present):

```ts
['alert.read', 'alerts'],
['alert.ack', 'alerts'],
['alert.manage', 'alerts'],
['channel.read', 'channels'],
['channel.manage', 'channels'],
['dashboard.read', 'dashboards'],
['dashboard.manage', 'dashboards'],
```

- [ ] **Step 3: Grant to roles**

In the broadest nexus agent role (the one with `service.manage`/`queue.manage`, e.g. ServiceDeskManager) append:
```ts
'alert.read', 'alert.ack', 'alert.manage', 'channel.read', 'channel.manage', 'dashboard.read', 'dashboard.manage',
```
In read/responder agent roles (Tier1/Tier2/SecurityAnalyst) append:
```ts
'alert.read', 'alert.ack', 'dashboard.read',
```
Customer-plane roles: no new keys.

- [ ] **Step 4: Typecheck** — `cd apps/api && npx tsc --noEmit` (clean).

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/db/seed.ts
git commit -m "feat(authz): add alert/channel/dashboard permissions + grants"
```

---

## Task 2: Alerts migration

**Files:** Create `apps/api/src/db/migrations/0022_alerts.sql` (renumber if 0022 taken)

- [ ] **Step 1: Pick the migration number**

Run `ls apps/api/src/db/migrations | sort | tail -1`. Use the next free number (plan assumes `0022`).

- [ ] **Step 2: Write the migration** (RLS mirrors `0014_queues.sql`):

```sql
-- Operations alerts (Opsgenie-style). A signal with a lifecycle (triggered -> acknowledged
-- -> resolved) and dedup key. An alert can escalate into an on-call page and/or a ticket.
CREATE TABLE alerts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source               text NOT NULL DEFAULT 'manual',
  dedup_key            text,
  severity             text NOT NULL DEFAULT 'P3' CHECK (severity IN ('P1','P2','P3','P4')),
  state                text NOT NULL DEFAULT 'triggered' CHECK (state IN ('triggered','acknowledged','resolved')),
  summary              text NOT NULL,
  details              jsonb NOT NULL DEFAULT '{}',
  acknowledged_by      uuid REFERENCES users(id),
  acknowledged_at      timestamptz,
  resolved_at          timestamptz,
  escalated_page_id    uuid REFERENCES oncall_pages(id),
  escalated_ticket_id  uuid REFERENCES tickets(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Dedup: at most one OPEN (triggered/acknowledged) alert per (org, dedup_key).
CREATE UNIQUE INDEX alerts_open_dedup ON alerts (organization_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state <> 'resolved';

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_isolation ON alerts
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON alerts TO nexus_app;
```
(If `oncall_pages` or `tickets` table names differ, run `grep -rl "CREATE TABLE oncall_pages\|CREATE TABLE tickets" apps/api/src/db/migrations` to confirm — they exist from `0003`/`0001`.)

- [ ] **Step 3: Apply + verify the migration runs**

Run the repo's migrate command. Find it: `grep -n "migrate" apps/api/package.json`. Run that script (e.g. `npm --workspace apps/api run migrate`) against the dev DB and confirm it applies with no error. If no migrate script / DB unavailable, note it and rely on the next-start auto-migrate; do not block.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/db/migrations/0022_alerts.sql
git commit -m "feat(alerts): alerts table + RLS + open-alert dedup index"
```

---

## Task 3: Alerts pure state-machine (TDD)

**Files:** Create `apps/api/src/modules/alerts.ts`; Create `apps/api/test/alerts.test.ts`

- [ ] **Step 1: Failing test** — create `apps/api/test/alerts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canAlertTransition } from '../src/modules/alerts.js';

describe('canAlertTransition', () => {
  it('triggered can be acknowledged or resolved', () => {
    expect(canAlertTransition('triggered', 'acknowledged')).toBe(true);
    expect(canAlertTransition('triggered', 'resolved')).toBe(true);
  });
  it('acknowledged can be resolved', () => {
    expect(canAlertTransition('acknowledged', 'resolved')).toBe(true);
  });
  it('resolved is terminal', () => {
    expect(canAlertTransition('resolved', 'acknowledged')).toBe(false);
    expect(canAlertTransition('resolved', 'triggered')).toBe(false);
  });
  it('no-op and backward transitions are rejected', () => {
    expect(canAlertTransition('acknowledged', 'triggered')).toBe(false);
    expect(canAlertTransition('triggered', 'triggered')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `cd apps/api && npx vitest run test/alerts.test.ts` (module not found).

- [ ] **Step 3: Implement the module skeleton + pure fn** — create `apps/api/src/modules/alerts.ts`:

```ts
// Operations alerts (Opsgenie-style). triggered -> acknowledged -> resolved, with dedup
// on (org, dedup_key) for open alerts, and escalation into an on-call page and/or ticket.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import * as oncall from './oncall.js';
import * as tickets from './tickets.js';
import type { Principal } from '../types.js';

export type AlertState = 'triggered' | 'acknowledged' | 'resolved';

const TRANSITIONS: Record<AlertState, AlertState[]> = {
  triggered: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

/** Is an alert state transition allowed? Pure. */
export function canAlertTransition(from: AlertState, to: AlertState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
```

- [ ] **Step 4: Run — expect PASS** (4 passing): `cd apps/api && npx vitest run test/alerts.test.ts`.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/modules/alerts.ts apps/api/test/alerts.test.ts
git commit -m "feat(alerts): alert state-machine + tests"
```

---

## Task 4: Alerts CRUD/ingest/ack/resolve/escalate + routes + client + page

**Files:** Modify `apps/api/src/modules/alerts.ts`, `apps/api/src/http/routes.ts`, `apps/web/lib/api.ts`; Create `apps/web/app/(app)/alerts/page.tsx`

- [ ] **Step 1: Append CRUD/lifecycle to `alerts.ts`**

```ts
export async function listAlerts(actor: Principal, filter: { state?: string; severity?: string } = {}) {
  authorize(actor, 'alert.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.state) { params.push(filter.state); where.push(`state = $${params.length}`); }
    if (filter.severity) { params.push(filter.severity); where.push(`severity = $${params.length}`); }
    const { rows } = await sql.query(
      `SELECT id, organization_id, source, dedup_key, severity, state, summary,
              acknowledged_at, resolved_at, escalated_page_id, escalated_ticket_id, created_at
         FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY (state='triggered') DESC, created_at DESC LIMIT 200`,
      params,
    );
    return rows;
  });
}

export interface CreateAlertInput { summary: string; severity?: string; source?: string; dedupKey?: string; details?: Record<string, unknown>; organizationId?: string; }

/** Ingest an alert. If an open alert with the same (org, dedupKey) exists, return it unchanged (dedup). */
export async function createAlert(actor: Principal, input: CreateAlertInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'alert.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    if (input.dedupKey) {
      const existing = (await sql.query(
        `SELECT * FROM alerts WHERE organization_id=$1 AND dedup_key=$2 AND state <> 'resolved' LIMIT 1`,
        [orgId, input.dedupKey],
      )).rows[0];
      if (existing) return existing;
    }
    const { rows } = await sql.query(
      `INSERT INTO alerts (organization_id, source, dedup_key, severity, summary, details)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, input.source ?? 'manual', input.dedupKey ?? null, input.severity ?? 'P3', input.summary, JSON.stringify(input.details ?? {})],
    );
    const alert = rows[0];
    await audit(actor, { action: 'alert.create', organizationId: orgId, resourceType: 'alert', resourceId: alert.id, detail: { severity: alert.severity } });
    publish('alert.created', orgId, { alert_id: alert.id, severity: alert.severity });
    return alert;
  });
}

async function transition(actor: Principal, id: string, to: AlertState, verb: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM alerts WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('alert not found');
    authorize(actor, verb, { organizationId: cur.organization_id });
    if (!canAlertTransition(cur.state as AlertState, to)) throw Errors.conflict(`cannot move alert from ${cur.state} to ${to}`);
    const ackBy = to === 'acknowledged' ? actor.id : cur.acknowledged_by;
    const ackAt = to === 'acknowledged' ? new Date().toISOString() : cur.acknowledged_at;
    const resAt = to === 'resolved' ? new Date().toISOString() : cur.resolved_at;
    const { rows } = await sql.query(
      `UPDATE alerts SET state=$1, acknowledged_by=$2, acknowledged_at=$3, resolved_at=$4 WHERE id=$5 RETURNING *`,
      [to, ackBy, ackAt, resAt, id],
    );
    await audit(actor, { action: `alert.${to}`, organizationId: cur.organization_id, resourceType: 'alert', resourceId: id });
    return rows[0];
  });
}

export const acknowledgeAlert = (actor: Principal, id: string) => transition(actor, id, 'acknowledged', 'alert.ack');
export const resolveAlert = (actor: Principal, id: string) => transition(actor, id, 'resolved', 'alert.ack');

/** Escalate an alert into an on-call page and a ticket; store the back-references. */
export async function escalateAlert(actor: Principal, id: string, opts: { toPage?: boolean; toTicket?: boolean } = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM alerts WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('alert not found');
    authorize(actor, 'alert.manage', { organizationId: cur.organization_id });
    let pageId = cur.escalated_page_id as string | null;
    let ticketId = cur.escalated_ticket_id as string | null;
    if (opts.toTicket && !ticketId) {
      const t = await tickets.createTicket(actor, { subject: cur.summary, type: 'incident', organizationId: cur.organization_id, priority: cur.severity } as any);
      ticketId = t.id;
    }
    if (opts.toPage && !pageId) {
      const pg = await oncall.createPage(actor, { ticketId: ticketId ?? undefined, organizationId: cur.organization_id, severity: cur.severity });
      pageId = pg.id;
    }
    await sql.query('UPDATE alerts SET escalated_page_id=$1, escalated_ticket_id=$2 WHERE id=$3', [pageId, ticketId, id]);
    await audit(actor, { action: 'alert.escalate', organizationId: cur.organization_id, resourceType: 'alert', resourceId: id, detail: { pageId, ticketId } });
    return { id, escalated_page_id: pageId, escalated_ticket_id: ticketId };
  });
}
```
IMPORTANT: verify `tickets.createTicket`'s real `CreateTicketInput` fields (`grep -n "interface CreateTicketInput" -A 10 apps/api/src/modules/tickets.ts`) and `oncall.createPage` accepts `{ ticketId?, organizationId?, severity? }` (it does). Adapt the createTicket call to the real field names (e.g. it may require `description`); keep the `as any` only if necessary and prefer real fields. Confirm `publish` signature `(eventType, organizationId, payload)` via `grep -n "export function publish" -A 6 apps/api/src/events/bus.js` and adapt if different.

- [ ] **Step 2: Register routes** (re-read routes.ts; `git status` guard; add `import * as alerts from '../modules/alerts.js';`):
```ts
app.get('/api/v1/alerts', async (req) => { const p = await requirePrincipal(req); const q = z.object({ state: z.string().optional(), severity: z.string().optional() }).parse(req.query); return { data: await alerts.listAlerts(p, q) }; });
app.post('/api/v1/alerts', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ summary: z.string().min(1), severity: z.enum(['P1','P2','P3','P4']).optional(), source: z.string().optional(), dedupKey: z.string().optional(), details: z.record(z.any()).optional(), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return alerts.createAlert(p, b); });
app.post('/api/v1/alerts/:id/ack', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return alerts.acknowledgeAlert(p, id); });
app.post('/api/v1/alerts/:id/resolve', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return alerts.resolveAlert(p, id); });
app.post('/api/v1/alerts/:id/escalate', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ toPage: z.boolean().optional(), toTicket: z.boolean().optional() }).parse(req.body ?? {}); return alerts.escalateAlert(p, id, b); });
```

- [ ] **Step 3: Client helpers** (re-read api.ts; append):
```ts
export interface Alert { id: string; organization_id: string; source: string; dedup_key: string | null; severity: string; state: string; summary: string; acknowledged_at: string | null; resolved_at: string | null; escalated_page_id: string | null; escalated_ticket_id: string | null; created_at: string; }
export const alertsApi = {
  list: (q = '') => api.get<{ data: Alert[] }>(`/alerts${q}`).then((r) => r.data),
  create: (b: { summary: string; severity?: string; source?: string; dedupKey?: string; organizationId?: string }) => api.post<Alert>('/alerts', b),
  ack: (id: string) => api.post<Alert>(`/alerts/${id}/ack`),
  resolve: (id: string) => api.post<Alert>(`/alerts/${id}/resolve`),
  escalate: (id: string, b: { toPage?: boolean; toTicket?: boolean }) => api.post(`/alerts/${id}/escalate`, b),
};
```

- [ ] **Step 4: Create `apps/web/app/(app)/alerts/page.tsx`**:
```tsx
'use client';
import React from 'react';
import { alertsApi, type Alert } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Select } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';

export default function AlertsPage() {
  const { can } = useAuth();
  const [rows, setRows] = React.useState<Alert[] | null>(null);
  const [state, setState] = React.useState('');

  const load = React.useCallback(() => {
    setRows(null);
    alertsApi.list(state ? `?state=${state}` : '').then(setRows).catch(() => setRows([]));
  }, [state]);
  React.useEffect(() => { load(); }, [load]);

  const open = (rows ?? []).filter((a) => a.state === 'triggered').length;
  const canAck = can('alert.ack');
  const canManage = can('alert.manage');

  async function act(p: Promise<unknown>) { await p; load(); }

  return (
    <div className="space-y-5">
      <div><h1 className="text-2xl font-semibold tracking-tight">Alerts</h1><p className="mt-1 text-sm text-muted">Operational alert feed.</p></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Triggered" value={rows === null ? '—' : open} />
        <StatCard label="Acknowledged" value={rows === null ? '—' : (rows.filter((a) => a.state === 'acknowledged').length)} />
        <StatCard label="Total (open+recent)" value={rows === null ? '—' : rows.length} />
      </div>
      <div className="flex gap-3">
        <Select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option><option value="triggered">Triggered</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option>
        </Select>
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Alert>
            rows={rows}
            columns={[
              { key: 'severity', header: 'Sev', render: (a) => a.severity },
              { key: 'summary', header: 'Summary', render: (a) => a.summary },
              { key: 'source', header: 'Source', render: (a) => a.source },
              { key: 'state', header: 'State', render: (a) => a.state },
              { key: 'actions', header: '', render: (a) => (
                <div className="flex gap-2">
                  {canAck && a.state === 'triggered' && <Button size="sm" variant="outline" onClick={() => act(alertsApi.ack(a.id))}>Ack</Button>}
                  {canAck && a.state !== 'resolved' && <Button size="sm" variant="outline" onClick={() => act(alertsApi.resolve(a.id))}>Resolve</Button>}
                  {canManage && a.state !== 'resolved' && <Button size="sm" variant="outline" onClick={() => act(alertsApi.escalate(a.id, { toPage: true, toTicket: true }))}>Escalate</Button>}
                </div>
              ) },
            ]}
            empty={<EmptyState title="No alerts" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
```
Confirm `Button` accepts `size="sm"`/`variant="outline"` (it does, per primitives) and DataTable columns API; adapt if needed.

- [ ] **Step 5: Typecheck both** — `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit`; run `cd apps/api && npx vitest run test/alerts.test.ts`. Fix mismatches.

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/modules/alerts.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/alerts/page.tsx"
git commit -m "feat(alerts): ingest/ack/resolve/escalate API, client, and /alerts feed"
```

---

## Task 5: Channels migration

**Files:** Create `apps/api/src/db/migrations/0023_channels.sql` (renumber if taken)

- [ ] **Step 1: Pick next free number** (`ls ... | sort | tail -1`).

- [ ] **Step 2: Write migration**:
```sql
-- Configurable intake channels (email inbox / portal / widget). The ticket source_channel
-- string can reference one of these by name; no destructive migration of existing values.
CREATE TABLE channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('email','portal','widget')),
  name             text NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}',
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY channels_isolation ON channels
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON channels TO nexus_app;
```

- [ ] **Step 3: Apply migration** (same as Task 2 Step 3).

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/db/migrations/0023_channels.sql
git commit -m "feat(channels): channels table + RLS"
```

---

## Task 6: Channels module + routes + client + page

**Files:** Create `apps/api/src/modules/channels.ts`; Modify `routes.ts`, `api.ts`; Create `apps/web/app/(app)/channels/page.tsx`

- [ ] **Step 1: Create `channels.ts`**:
```ts
// Configurable intake channels (email/portal/widget) per org.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export async function listChannels(actor: Principal) {
  authorize(actor, 'channel.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT id, organization_id, type, name, config, enabled, created_at FROM channels ORDER BY type, name');
    return rows;
  });
}

export interface SaveChannelInput { type: 'email' | 'portal' | 'widget'; name: string; config?: Record<string, unknown>; enabled?: boolean; organizationId?: string; }

export async function createChannel(actor: Principal, input: SaveChannelInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'channel.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO channels (organization_id, type, name, config, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.type, input.name, JSON.stringify(input.config ?? {}), input.enabled ?? true],
    );
    await audit(actor, { action: 'channel.create', organizationId: orgId, resourceType: 'channel', resourceId: rows[0].id, detail: { type: input.type } });
    return rows[0];
  });
}

export async function updateChannel(actor: Principal, id: string, input: Partial<SaveChannelInput>) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('channel not found');
    authorize(actor, 'channel.manage', { organizationId: cur.organization_id });
    const { rows } = await sql.query(
      `UPDATE channels SET name=$1, config=$2, enabled=$3, updated_at=now() WHERE id=$4 RETURNING *`,
      [input.name ?? cur.name, JSON.stringify(input.config ?? cur.config), input.enabled ?? cur.enabled, id],
    );
    await audit(actor, { action: 'channel.update', organizationId: cur.organization_id, resourceType: 'channel', resourceId: id });
    return rows[0];
  });
}
```

- [ ] **Step 2: Routes** (re-read; guard; `import * as channels from '../modules/channels.js';`):
```ts
app.get('/api/v1/channels', async (req) => { const p = await requirePrincipal(req); return { data: await channels.listChannels(p) }; });
app.post('/api/v1/channels', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ type: z.enum(['email','portal','widget']), name: z.string().min(1), config: z.record(z.any()).optional(), enabled: z.boolean().optional(), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return channels.createChannel(p, b); });
app.patch('/api/v1/channels/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ name: z.string().optional(), config: z.record(z.any()).optional(), enabled: z.boolean().optional() }).parse(req.body); return channels.updateChannel(p, id, b); });
```

- [ ] **Step 3: Client** (append to api.ts):
```ts
export interface Channel { id: string; organization_id: string; type: string; name: string; config: Record<string, unknown>; enabled: boolean; created_at: string; }
export const channelsApi = {
  list: () => api.get<{ data: Channel[] }>('/channels').then((r) => r.data),
  create: (b: { type: string; name: string; config?: Record<string, unknown>; enabled?: boolean; organizationId?: string }) => api.post<Channel>('/channels', b),
  update: (id: string, b: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) => api.patch<Channel>(`/channels/${id}`, b),
};
```

- [ ] **Step 4: Page** `apps/web/app/(app)/channels/page.tsx`:
```tsx
'use client';
import React from 'react';
import { channelsApi, type Channel } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function ChannelsPage() {
  const { can } = useAuth();
  const [rows, setRows] = React.useState<Channel[] | null>(null);
  const load = React.useCallback(() => { setRows(null); channelsApi.list().then(setRows).catch(() => setRows([])); }, []);
  React.useEffect(() => { load(); }, [load]);
  const canManage = can('channel.manage');

  async function toggle(c: Channel) { await channelsApi.update(c.id, { enabled: !c.enabled }); load(); }

  return (
    <div className="space-y-5">
      <div><h1 className="text-2xl font-semibold tracking-tight">Channels</h1><p className="mt-1 text-sm text-muted">Configured intake channels.</p></div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Channel>
            rows={rows}
            columns={[
              { key: 'name', header: 'Name', render: (c) => c.name },
              { key: 'type', header: 'Type', render: (c) => <Badge>{c.type}</Badge> },
              { key: 'enabled', header: 'Enabled', render: (c) => c.enabled ? 'Yes' : 'No' },
              { key: 'actions', header: '', render: (c) => canManage ? <Button size="sm" variant="outline" onClick={() => toggle(c)}>{c.enabled ? 'Disable' : 'Enable'}</Button> : null },
            ]}
            empty={<EmptyState title="No channels configured" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck both** + fix. **Step 6: Commit**
```bash
git add apps/api/src/modules/channels.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/channels/page.tsx"
git commit -m "feat(channels): channel CRUD API, client, and /channels page"
```

---

## Task 7: Dashboards migration + default seed

**Files:** Create `apps/api/src/db/migrations/0024_dashboards.sql` (renumber if taken)

- [ ] **Step 1: Pick next free number.**

- [ ] **Step 2: Write migration**:
```sql
-- Named dashboards with a preset-widget layout. layout is an ordered jsonb array of widget
-- descriptors, each {type: <widget key>}. A per-org default named "Operations overview" is
-- seeded for existing orgs; the fixed /dashboard view remains the fallback.
CREATE TABLE dashboards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id    uuid REFERENCES users(id),            -- NULL = shared/org-wide
  name             text NOT NULL,
  layout           jsonb NOT NULL DEFAULT '[]',
  is_default       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY dashboards_isolation ON dashboards
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboards TO nexus_app;

-- Seed a shared default dashboard per existing org with the standard widget set.
INSERT INTO dashboards (organization_id, owner_user_id, name, layout, is_default)
SELECT id, NULL, 'Operations overview',
  '[{"type":"kpis"},{"type":"ticket_volume"},{"type":"posture_gauge"},{"type":"top_findings"}]'::jsonb, true
FROM organizations;
```

- [ ] **Step 3: Apply migration. Step 4: Commit**
```bash
git add apps/api/src/db/migrations/0024_dashboards.sql
git commit -m "feat(dashboards): dashboards table + RLS + seeded default per org"
```

---

## Task 8: Dashboards module + routes + client + page

**Files:** Create `apps/api/src/modules/dashboards.ts`; Modify `routes.ts`, `api.ts`; Create `apps/web/app/(app)/dashboards/page.tsx`

- [ ] **Step 1: Create `dashboards.ts`** (widget catalog is a fixed const; widget DATA reuses `analytics.overview`):
```ts
// Named dashboards over a fixed widget library. Widget data reuses existing analytics/posture
// queries — this module owns dashboard records + the widget catalog only.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export const WIDGET_CATALOG = ['kpis', 'ticket_volume', 'posture_gauge', 'top_findings', 'sla_breaches', 'recent_tickets'] as const;
export type WidgetType = (typeof WIDGET_CATALOG)[number];
export interface Widget { type: WidgetType }

/** Keep only known widget types, preserving order. Pure. */
export function sanitizeLayout(layout: unknown): Widget[] {
  if (!Array.isArray(layout)) return [];
  return layout
    .filter((w): w is { type: string } => !!w && typeof (w as any).type === 'string')
    .filter((w) => (WIDGET_CATALOG as readonly string[]).includes(w.type))
    .map((w) => ({ type: w.type as WidgetType }));
}

export async function listDashboards(actor: Principal) {
  authorize(actor, 'dashboard.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      'SELECT id, organization_id, owner_user_id, name, layout, is_default, created_at FROM dashboards ORDER BY is_default DESC, name',
    );
    return rows;
  });
}

export interface SaveDashboardInput { name: string; layout?: unknown; organizationId?: string; }

export async function createDashboard(actor: Principal, input: SaveDashboardInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'dashboard.manage', { organizationId: orgId });
  const layout = sanitizeLayout(input.layout);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO dashboards (organization_id, owner_user_id, name, layout, is_default) VALUES ($1,$2,$3,$4,false) RETURNING *`,
      [orgId, actor.id, input.name, JSON.stringify(layout)],
    );
    await audit(actor, { action: 'dashboard.create', organizationId: orgId, resourceType: 'dashboard', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function updateDashboard(actor: Principal, id: string, input: SaveDashboardInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM dashboards WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('dashboard not found');
    authorize(actor, 'dashboard.manage', { organizationId: cur.organization_id });
    const layout = input.layout !== undefined ? sanitizeLayout(input.layout) : cur.layout;
    const { rows } = await sql.query(
      `UPDATE dashboards SET name=$1, layout=$2, updated_at=now() WHERE id=$3 RETURNING *`,
      [input.name ?? cur.name, JSON.stringify(layout), id],
    );
    await audit(actor, { action: 'dashboard.update', organizationId: cur.organization_id, resourceType: 'dashboard', resourceId: id });
    return rows[0];
  });
}

export async function deleteDashboard(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM dashboards WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('dashboard not found');
    authorize(actor, 'dashboard.manage', { organizationId: cur.organization_id });
    if (cur.is_default) throw Errors.conflict('cannot delete the default dashboard');
    await sql.query('DELETE FROM dashboards WHERE id=$1', [id]);
    await audit(actor, { action: 'dashboard.delete', organizationId: cur.organization_id, resourceType: 'dashboard', resourceId: id });
    return { ok: true };
  });
}
```
Add a vitest test `apps/api/test/dashboards.test.ts` for `sanitizeLayout` (drops unknown types, drops non-arrays, preserves order) BEFORE wiring CRUD — TDD the pure fn:
```ts
import { describe, it, expect } from 'vitest';
import { sanitizeLayout } from '../src/modules/dashboards.js';
describe('sanitizeLayout', () => {
  it('drops unknown widget types and preserves order', () => {
    expect(sanitizeLayout([{ type: 'kpis' }, { type: 'bogus' }, { type: 'top_findings' }])).toEqual([{ type: 'kpis' }, { type: 'top_findings' }]);
  });
  it('returns [] for non-arrays and malformed entries', () => {
    expect(sanitizeLayout(null)).toEqual([]);
    expect(sanitizeLayout([{}, 3, 'x'])).toEqual([]);
  });
});
```
Run `cd apps/api && npx vitest run test/dashboards.test.ts` — must pass.

- [ ] **Step 2: Routes** (re-read; guard; `import * as dashboards from '../modules/dashboards.js';`):
```ts
app.get('/api/v1/dashboards', async (req) => { const p = await requirePrincipal(req); return { data: await dashboards.listDashboards(p) }; });
app.post('/api/v1/dashboards', async (req, reply) => { const p = await requirePrincipal(req); const b = z.object({ name: z.string().min(1), layout: z.array(z.object({ type: z.string() })).optional(), organizationId: z.string().uuid().optional() }).parse(req.body); reply.code(201); return dashboards.createDashboard(p, b); });
app.patch('/api/v1/dashboards/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ name: z.string().optional(), layout: z.array(z.object({ type: z.string() })).optional() }).parse(req.body); return dashboards.updateDashboard(p, id, b); });
app.delete('/api/v1/dashboards/:id', async (req) => { const p = await requirePrincipal(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return dashboards.deleteDashboard(p, id); });
```

- [ ] **Step 3: Client** (append):
```ts
export interface Dashboard { id: string; organization_id: string; owner_user_id: string | null; name: string; layout: { type: string }[]; is_default: boolean; }
export const dashboardsApi = {
  list: () => api.get<{ data: Dashboard[] }>('/dashboards').then((r) => r.data),
  create: (b: { name: string; layout?: { type: string }[]; organizationId?: string }) => api.post<Dashboard>('/dashboards', b),
  update: (id: string, b: { name?: string; layout?: { type: string }[] }) => api.patch<Dashboard>(`/dashboards/${id}`, b),
  remove: (id: string) => api.del<{ ok: true }>(`/dashboards/${id}`),
};
```

- [ ] **Step 4: Page** `apps/web/app/(app)/dashboards/page.tsx` (list named dashboards; selecting one renders its widget descriptors as labeled placeholders that reuse the existing analytics overview where applicable — keep it simple: show the widget list; the existing `/dashboard` remains the rich default):
```tsx
'use client';
import React from 'react';
import Link from 'next/link';
import { dashboardsApi, type Dashboard } from '@/lib/api';
import { Card, CardBody, Badge } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';

const WIDGET_LABEL: Record<string, string> = {
  kpis: 'KPI cards', ticket_volume: 'Ticket volume', posture_gauge: 'Posture gauge',
  top_findings: 'Top posture findings', sla_breaches: 'SLA breaches', recent_tickets: 'Recent tickets',
};

export default function DashboardsPage() {
  const [list, setList] = React.useState<Dashboard[] | null>(null);
  const [active, setActive] = React.useState<Dashboard | null>(null);
  React.useEffect(() => { dashboardsApi.list().then((d) => { setList(d); setActive(d.find((x) => x.is_default) ?? d[0] ?? null); }).catch(() => setList([])); }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1><p className="mt-1 text-sm text-muted">Named dashboards. The rich live overview is at <Link className="text-brand hover:underline" href="/dashboard">/dashboard</Link>.</p></div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <Card><CardBody className="space-y-1">
          {list === null ? <Skeleton className="h-8" /> : list.length === 0 ? <EmptyState title="No dashboards" /> : list.map((d) => (
            <button key={d.id} onClick={() => setActive(d)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${active?.id === d.id ? 'bg-brand/15 text-brand' : 'hover:bg-surface-2 text-fg'}`}>
              {d.name}{d.is_default && <span className="ml-2 text-xs text-muted">default</span>}
            </button>
          ))}
        </CardBody></Card>
        <Card><CardBody>
          {!active ? <EmptyState title="Select a dashboard" /> : (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{active.name}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {active.layout.map((w, i) => (
                  <div key={i} className="rounded-lg border border-border bg-surface-2 px-4 py-6 text-center">
                    <Badge>{WIDGET_LABEL[w.type] ?? w.type}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardBody></Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck both** + `npx vitest run test/dashboards.test.ts`. **Step 6: Commit**
```bash
git add apps/api/src/modules/dashboards.ts apps/api/test/dashboards.test.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/dashboards/page.tsx"
git commit -m "feat(dashboards): named dashboards CRUD + widget catalog API, client, and /dashboards page"
```

---

## Task 9: Nav entries

**Files:** Modify `apps/web/components/shell.tsx`

- [ ] **Step 1: Re-read shell.tsx** (`git status` guard). Confirm which of `/alerts`,`/channels`,`/dashboards` are absent (add only missing).

- [ ] **Step 2: Add icons** (match existing 18x18 style) near the other `Icon*`:
```tsx
function IconBell() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>; }
function IconPlug() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8zM12 16v6"/></svg>; }
function IconGauge() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 13l4-4M5 19a9 9 0 1 1 14 0"/></svg>; }
```

- [ ] **Step 3: Add NEXUS_NAV entries** (alerts near /oncall; channels near /automations; dashboards near top after /dashboard):
```tsx
{ href: '/alerts', label: 'Alerts', icon: <IconBell />, anyPerm: ['alert.read'] },
{ href: '/channels', label: 'Channels', icon: <IconPlug />, anyPerm: ['channel.read', 'channel.manage'] },
{ href: '/dashboards', label: 'Dashboards', icon: <IconGauge />, anyPerm: ['dashboard.read'] },
```

- [ ] **Step 4: titleFor cases**:
```ts
if (path.startsWith('/alerts')) return 'Alerts';
if (path.startsWith('/channels')) return 'Channels';
if (path.startsWith('/dashboards')) return 'Dashboards';
```

- [ ] **Step 5: Typecheck** — `cd apps/web && npx tsc --noEmit`.

- [ ] **Step 6: Commit**
```bash
git add apps/web/components/shell.tsx
git commit -m "feat(nav): surface alerts, channels, dashboards in agent nav"
```

---

## Self-Review

**1. Spec coverage (Phase 2):**
- Alerts new entity (triggered→ack→resolved, dedup, escalate to page+ticket) → Tasks 2,3,4 ✓ (matches spec decision "new entity, can escalate")
- Channels (email/portal/widget config, enable/disable) → Tasks 5,6 ✓
- Dashboards (multiple named, fixed preset-widget library, seeded default "Operations overview") → Tasks 7,8 ✓ (matches spec decision "named, preset widgets")
- Permissions added + granted → Task 1 ✓
- Nav surfaced → Task 9 ✓
- Phase 3 (nav restructure into sections, Get started, Archived) remains a separate plan.

**2. Placeholder scan:** No TBD/TODO. Every code step is complete. Conditional steps (migration renumber, "add only missing nav") are guarded by explicit checks, not placeholders.

**3. Type consistency:** `AlertState` + `canAlertTransition` (Task 3) reused by `transition`/ack/resolve (Task 4). `WIDGET_CATALOG`/`sanitizeLayout`/`Widget` (Task 8) used consistently in CRUD and tested. Client interfaces (`Alert`/`Channel`/`Dashboard`) match the explicit SELECT column lists. Routes use `requirePrincipal` + zod (the real Phase-1-confirmed idiom) and `{data}` envelopes matching client unwraps. Escalation calls `tickets.createTicket` and `oncall.createPage` — Task 4 Step 1 flags verifying their real signatures before finalizing. Migration RLS mirrors the verified `0014_queues.sql` template; FK targets (`oncall_pages`, `tickets`, `organizations`, `users`) all exist.

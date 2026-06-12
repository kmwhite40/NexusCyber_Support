# Phase 2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add integration tests for the new modules (alerts/channels/dashboards/services), make `/dashboards` render real data, and add create UIs for Channels and Dashboards — reusing existing endpoints only.

**Architecture:** Integration tests follow the repo's `apps/api/test/integration/*.int.test.ts` pattern (`describeDb` skip-guard, `principalByEmail`, direct module calls). A `DashboardWidget` client component maps widget types to live panels using existing endpoints (`/analytics/overview`, `/posture/score`, `/posture/findings`, `/tickets`). Create UIs use the established inline-modal pattern + existing client helpers.

**Tech Stack:** Fastify + Postgres API; Next.js 14 + Tailwind web; vitest. No new deps, endpoints, or migrations.

**Spec:** `docs/superpowers/specs/2026-06-12-phase2-hardening-design.md`

---

## Collision protocol

Concurrent process is on catalog/forms — these files are collision-free, but still: before editing `channels/page.tsx`, `dashboards/page.tsx`, `lib/api.ts`, run `git status --short <file>` (BLOCK if `M`), RE-READ, splice, surgical `git add`. New test files + the new widget component are net-new (no contention).

**Running integration tests:** they only run when `DATABASE_URL` is set (`describeDb` skips otherwise). Run them against the dev DB on 5544 with: `cd apps/api && npx vitest run --env-file=../../.env test/integration/<file>`. Gate for web: `cd apps/web && npx tsc --noEmit`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/test/integration/services.int.test.ts` | services/CMDB CRUD + denial |
| `apps/api/test/integration/channels.int.test.ts` | channels CRUD + denial |
| `apps/api/test/integration/dashboards.int.test.ts` | dashboards CRUD + sanitizeLayout + default-delete guard |
| `apps/api/test/integration/alerts.int.test.ts` | alerts dedup + transitions + escalation + denial |
| `apps/web/components/ui/dashboard-widgets.tsx` | `DashboardWidget({ type, overview })` live panels |
| `apps/web/app/(app)/dashboards/page.tsx` (modify) | render widgets live + "New dashboard" modal |
| `apps/web/app/(app)/channels/page.tsx` (modify) | "New channel" modal |
| `apps/web/lib/api.ts` (modify only if a helper is missing) | reuse existing `*Api` helpers |

---

## Task 1: services integration test

**Files:** Create `apps/api/test/integration/services.int.test.ts`

- [ ] **Step 1: Write the test** (mirror `queues.int.test.ts`'s `principalByEmail` + `describeDb`):

```ts
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listServices, createService, listConfigurationItems, createConfigurationItem } from '../../src/modules/services.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('services/CMDB (integration)', () => {
  let manager: Principal;
  let enduser: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    enduser = await principalByEmail('user@acme.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('manager can create a service and a CI, and list returns them with ticket_count', async () => {
    const svc = await createService(manager, { name: 'Test API', kind: 'application', organizationId: orgId });
    expect(svc.id).toBeTruthy();
    const ci = await createConfigurationItem(manager, { name: 'db-int-01', ciClass: 'database', criticality: 'high', organizationId: orgId });
    expect(ci.id).toBeTruthy();
    const services = await listServices(manager);
    expect(services.some((s: any) => s.id === svc.id)).toBe(true);
    expect(services.find((s: any) => s.id === svc.id)).toHaveProperty('ticket_count');
    const cis = await listConfigurationItems(manager, {});
    expect(cis.some((c: any) => c.id === ci.id)).toBe(true);
  });

  it('a customer end-user (no service.manage) is denied create', async () => {
    await expect(createService(enduser, { name: 'Nope', organizationId: orgId })).rejects.toThrow();
  });
});
```
NOTE: confirm a seeded customer user exists for the denial test — run `curl -s http://localhost:4000/api/v1/auth/dev-users` (or `SELECT email FROM users WHERE plane='customer' LIMIT 3`) and use a real customer email (e.g. `user@acme.example.com` or `admin@acme.example.com`). EndUser lacks `service.manage`, so `createService` must reject. If `loadPrincipal`'s signature differs, copy the exact call from `queues.int.test.ts`.

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run --env-file=../../.env test/integration/services.int.test.ts`. Expected: PASS (2). If a customer principal still has the perm or the denial doesn't throw, adjust the chosen user to one demonstrably lacking `service.manage`.

- [ ] **Step 3: Commit**
```bash
git add apps/api/test/integration/services.int.test.ts
git commit -m "test(services): integration — CRUD happy-path + manage denial"
```

## Task 2: channels integration test

**Files:** Create `apps/api/test/integration/channels.int.test.ts`

- [ ] **Step 1: Write the test**:
```ts
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listChannels, createChannel, updateChannel } from '../../src/modules/channels.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('channels (integration)', () => {
  let manager: Principal;
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    agent = await principalByEmail('agent@nexus.example.com'); // Tier2: no channel.manage/read
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('manager creates, lists, and toggles a channel', async () => {
    const ch = await createChannel(manager, { type: 'email', name: 'int-support', organizationId: orgId });
    expect(ch.enabled).toBe(true);
    const list = await listChannels(manager);
    expect(list.some((c: any) => c.id === ch.id)).toBe(true);
    const updated = await updateChannel(manager, ch.id, { enabled: false });
    expect(updated.enabled).toBe(false);
  });

  it('a Tier2 agent without channel.read is denied list', async () => {
    await expect(listChannels(agent)).rejects.toThrow();
  });
});
```
(Tier2 was granted `alert.read`/`dashboard.read` but NOT `channel.read` — confirm in `seed.ts`; if Tier2 was later granted channel.read, pick a role/user that lacks it for the denial test.)

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run --env-file=../../.env test/integration/channels.int.test.ts`. Expected: PASS (2).

- [ ] **Step 3: Commit**
```bash
git add apps/api/test/integration/channels.int.test.ts
git commit -m "test(channels): integration — CRUD/toggle + read denial"
```

## Task 3: dashboards integration test

**Files:** Create `apps/api/test/integration/dashboards.int.test.ts`

- [ ] **Step 1: Write the test**:
```ts
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listDashboards, createDashboard, deleteDashboard } from '../../src/modules/dashboards.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('dashboards (integration)', () => {
  let manager: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('lists the seeded default dashboard', async () => {
    const list = await listDashboards(manager);
    expect(list.some((d: any) => d.is_default && d.name === 'Operations overview')).toBe(true);
  });

  it('create sanitizes the layout to known widget types only', async () => {
    const d = await createDashboard(manager, { name: 'Int board', layout: [{ type: 'kpis' }, { type: 'bogus' }, { type: 'top_findings' }] as any, organizationId: orgId });
    expect(d.layout).toEqual([{ type: 'kpis' }, { type: 'top_findings' }]);
  });

  it('cannot delete the default dashboard', async () => {
    const list = await listDashboards(manager);
    const def = list.find((d: any) => d.is_default);
    await expect(deleteDashboard(manager, def.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run --env-file=../../.env test/integration/dashboards.int.test.ts`. Expected: PASS (3).

- [ ] **Step 3: Commit**
```bash
git add apps/api/test/integration/dashboards.int.test.ts
git commit -m "test(dashboards): integration — seeded default, layout sanitize, default-delete guard"
```

## Task 4: alerts integration test (the bug-catcher)

**Files:** Create `apps/api/test/integration/alerts.int.test.ts`

- [ ] **Step 1: Write the test**:
```ts
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createAlert, acknowledgeAlert, resolveAlert, escalateAlert, listAlerts } from '../../src/modules/alerts.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('alerts (integration)', () => {
  let manager: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('dedups open alerts on the same dedup_key', async () => {
    const key = `int-dedup-${Date.now()}`;
    const a1 = await createAlert(manager, { summary: 'first', dedupKey: key, organizationId: orgId });
    const a2 = await createAlert(manager, { summary: 'second', dedupKey: key, organizationId: orgId });
    expect(a2.id).toBe(a1.id);
  });

  it('enforces the state machine: ack then resolve; resolved is terminal', async () => {
    const a = await createAlert(manager, { summary: 'lifecycle', severity: 'P2', organizationId: orgId });
    const acked = await acknowledgeAlert(manager, a.id);
    expect(acked.state).toBe('acknowledged');
    const resolved = await resolveAlert(manager, a.id);
    expect(resolved.state).toBe('resolved');
    await expect(acknowledgeAlert(manager, a.id)).rejects.toThrow(); // resolved -> acknowledged not allowed
  });

  it('escalation opens a ticket and a page and stores back-references', async () => {
    const a = await createAlert(manager, { summary: 'escalate me', severity: 'P1', organizationId: orgId });
    const res = await escalateAlert(manager, a.id, { toTicket: true, toPage: true });
    expect(res.escalated_ticket_id).toBeTruthy();
    expect(res.escalated_page_id).toBeTruthy();
    // idempotent: second escalate keeps the same refs
    const again = await escalateAlert(manager, a.id, { toTicket: true, toPage: true });
    expect(again.escalated_ticket_id).toBe(res.escalated_ticket_id);
    expect(again.escalated_page_id).toBe(res.escalated_page_id);
  });
});
```

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run --env-file=../../.env test/integration/alerts.int.test.ts`. Expected: PASS (3). The escalation test exercises the `ticket.create` path that previously 403'd — it must pass now that ServiceDeskManager has `ticket.create`.

- [ ] **Step 3: Run the whole suite to confirm no regressions** — `cd apps/api && npx vitest run --env-file=../../.env 2>&1 | tail -4`. Expected: all pass (integration suites now run, not skipped).

- [ ] **Step 4: Commit**
```bash
git add apps/api/test/integration/alerts.int.test.ts
git commit -m "test(alerts): integration — dedup, state machine, escalation idempotency"
```

## Task 5: dashboard widgets render real data

**Files:** Create `apps/web/components/ui/dashboard-widgets.tsx`; Modify `apps/web/app/(app)/dashboards/page.tsx`

- [ ] **Step 1: Confirm the overview shape**

Run `sed -n '33,55p' apps/api/src/modules/analytics.ts`. Confirm `overview()` returns `{ kpis: { totalTickets, avgResolutionDays, withinSlaPct, avgRating, totalAgents }, volumeByYear: [{year,count}], ... }`. Adapt field names below to the real ones.

- [ ] **Step 2: Create `apps/web/components/ui/dashboard-widgets.tsx`**:

```tsx
'use client';
import React from 'react';
import Link from 'next/link';
import { api, type Ticket } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { StatCard, Skeleton, EmptyState } from '@/components/ui/data';

export interface Overview {
  kpis: { totalTickets: number; avgResolutionDays: number; withinSlaPct: number; avgRating: number; totalAgents: number };
  volumeByYear: { year: number; count: number }[];
}

const WIDGET_LABEL: Record<string, string> = {
  kpis: 'KPIs', ticket_volume: 'Ticket volume', posture_gauge: 'Security posture',
  top_findings: 'Top posture findings', sla_breaches: 'SLA', recent_tickets: 'Recent tickets',
};

export function DashboardWidget({ type, overview }: { type: string; overview: Overview | null }) {
  if (type === 'kpis') {
    if (!overview) return <Skeleton className="h-20" />;
    const k = overview.kpis;
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total tickets" value={k.totalTickets} />
        <StatCard label="Within SLA" value={`${k.withinSlaPct}%`} />
        <StatCard label="Avg resolution (d)" value={k.avgResolutionDays} />
        <StatCard label="Avg rating" value={k.avgRating} />
      </div>
    );
  }
  if (type === 'sla_breaches') {
    if (!overview) return <Skeleton className="h-20" />;
    const k = overview.kpis;
    const breaches = Math.max(0, Math.round(k.totalTickets * (1 - k.withinSlaPct / 100)));
    return <div className="grid grid-cols-2 gap-3"><StatCard label="Within SLA" value={`${k.withinSlaPct}%`} /><StatCard label="Breached (approx)" value={breaches} /></div>;
  }
  if (type === 'ticket_volume') {
    if (!overview) return <Skeleton className="h-20" />;
    const max = Math.max(1, ...overview.volumeByYear.map((v) => v.count));
    return (
      <Card><CardBody>
        <div className="mb-2 text-xs font-medium text-muted">Ticket volume by year</div>
        <div className="space-y-1">
          {overview.volumeByYear.map((v) => (
            <div key={v.year} className="flex items-center gap-2 text-xs">
              <span className="w-10 tabular-nums text-muted">{v.year}</span>
              <div className="h-2 rounded bg-brand" style={{ width: `${(v.count / max) * 100}%` }} />
              <span className="tabular-nums text-fg">{v.count}</span>
            </div>
          ))}
        </div>
      </CardBody></Card>
    );
  }
  if (type === 'posture_gauge') return <PostureGauge />;
  if (type === 'top_findings') return <TopFindings />;
  if (type === 'recent_tickets') return <RecentTickets />;
  return <Card><CardBody><EmptyState title={WIDGET_LABEL[type] ?? type} /></CardBody></Card>;
}

function PostureGauge() {
  const [s, setS] = React.useState<{ overall_score: number; grade: string } | null>(null);
  const [done, setDone] = React.useState(false);
  React.useEffect(() => { api.get<{ overall_score: number; grade: string }>('/posture/score').then(setS).catch(() => {}).finally(() => setDone(true)); }, []);
  if (!done) return <Skeleton className="h-20" />;
  if (!s) return <Card><CardBody><EmptyState title="Posture unavailable" /></CardBody></Card>;
  return <div className="grid grid-cols-2 gap-3"><StatCard label="Posture score" value={s.overall_score} /><StatCard label="Grade" value={s.grade} /></div>;
}

interface Finding { id: string; title?: string; severity?: string; status?: string }
function TopFindings() {
  const [rows, setRows] = React.useState<Finding[] | null>(null);
  React.useEffect(() => { api.get<{ data: Finding[] }>('/posture/findings').then((r) => setRows(r.data.slice(0, 5))).catch(() => setRows([])); }, []);
  if (rows === null) return <Skeleton className="h-20" />;
  return (
    <Card><CardBody>
      <div className="mb-2 text-xs font-medium text-muted">Top posture findings</div>
      {rows.length === 0 ? <EmptyState title="No findings" /> : (
        <ul className="space-y-1 text-sm">{rows.map((f) => <li key={f.id} className="flex justify-between gap-2"><span className="truncate text-fg">{f.title ?? f.id}</span><span className="text-muted">{f.severity ?? ''}</span></li>)}</ul>
      )}
    </CardBody></Card>
  );
}

function RecentTickets() {
  const [rows, setRows] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => { api.get<{ data: Ticket[] }>('/tickets?limit=8').then((r) => setRows(r.data)).catch(() => setRows([])); }, []);
  if (rows === null) return <Skeleton className="h-20" />;
  return (
    <Card><CardBody>
      <div className="mb-2 text-xs font-medium text-muted">Recent tickets</div>
      {rows.length === 0 ? <EmptyState title="No tickets" /> : (
        <ul className="space-y-1 text-sm">{rows.map((t) => <li key={t.id}><Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link> <span className="text-muted">{t.subject}</span></li>)}</ul>
      )}
    </CardBody></Card>
  );
}
```
Confirm the `Finding` fields against `apps/web/app/(app)/dashboard/page.tsx` (it already renders findings) and adapt `title`/`severity` names. Confirm `StatCard` accepts `label`/`value`.

- [ ] **Step 3: Wire `/dashboards` page to render widgets live** — RE-READ `apps/web/app/(app)/dashboards/page.tsx`, then replace the placeholder badge grid with the live renderer. Remove the local `WIDGET_LABEL` placeholder block; fetch `overview` once; render each `active.layout` widget:

```tsx
// add imports
import { DashboardWidget, type Overview } from '@/components/ui/dashboard-widgets';
// inside component:
const [overview, setOverview] = React.useState<Overview | null>(null);
React.useEffect(() => { api.get<Overview>('/analytics/overview').then(setOverview).catch(() => setOverview(null)); }, []);
```
Replace the active-dashboard render block:
```tsx
<div className="space-y-3">
  <h2 className="text-lg font-semibold">{active.name}</h2>
  <div className="grid gap-4">
    {active.layout.map((w, i) => <DashboardWidget key={i} type={w.type} overview={overview} />)}
  </div>
</div>
```
(Keep the left dashboard list + selection logic as-is. `api` is already imported on the page; if not, add it.)

- [ ] **Step 4: Typecheck** — `cd apps/web && npx tsc --noEmit` (clean). Adapt field/prop mismatches.

- [ ] **Step 5: Commit**
```bash
git add apps/web/components/ui/dashboard-widgets.tsx "apps/web/app/(app)/dashboards/page.tsx"
git commit -m "feat(dashboards): render widgets with live data (KPIs, posture, volume, findings, recent tickets)"
```

## Task 6: Channels "New channel" modal

**Files:** Modify `apps/web/app/(app)/channels/page.tsx`

- [ ] **Step 1: RE-READ the page** (current full content is known; it imports `Card, CardBody, Button, Badge` + `DataTable, EmptyState, Skeleton`). Add `Select`, `Input`, `Field` to the primitives import, and `useAuth` already present. Add org sourcing for the nexus-plane org picker (mirror `/catalog`: `api.get<{data:{id,name}[]}>('/organizations')`).

- [ ] **Step 2: Add the modal + button**. Add state + a header button (gated by `canManage`) and an inline modal component:

```tsx
// add to imports:
import { Card, CardBody, Button, Badge, Select, Input, Field } from '@/components/ui/primitives';
import { api } from '@/lib/api';
// in component state:
const [creating, setCreating] = React.useState(false);
const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
const isAgent = !me?.organization_id; // nexus-plane has no org
React.useEffect(() => { if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {}); }, [isAgent]);
```
Header (replace the plain `<div>` title block's container with a flex row holding the button):
```tsx
<div className="flex items-center justify-between gap-3">
  <div><h1 className="text-2xl font-semibold tracking-tight">Channels</h1><p className="mt-1 text-sm text-muted">Configured intake channels.</p></div>
  {canManage && <Button onClick={() => setCreating(true)}>New channel</Button>}
</div>
```
Modal (render at end of the root div, before close):
```tsx
{creating && (
  <NewChannelModal orgs={orgs} isAgent={isAgent} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
)}
```
Modal component (append to the file):
```tsx
function NewChannelModal({ orgs, isAgent, onClose, onCreated }: { orgs: { id: string; name: string }[]; isAgent: boolean; onClose: () => void; onCreated: () => void }) {
  const [type, setType] = React.useState<'email' | 'portal' | 'widget'>('email');
  const [name, setName] = React.useState('');
  const [organizationId, setOrganizationId] = React.useState('');
  const [err, setErr] = React.useState('');
  async function save() {
    try {
      await channelsApi.create({ type, name, ...(isAgent ? { organizationId } : {}) });
      onCreated();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardBody className="space-y-3">
          <h2 className="text-lg font-semibold">New channel</h2>
          <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as any)}><option value="email">Email</option><option value="portal">Portal</option><option value="widget">Widget</option></Select></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="support@acme" /></Field>
          {isAgent && <Field label="Organization"><Select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}><option value="">Select…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>}
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name || (isAgent && !organizationId)}>Create</Button></div>
        </CardBody>
      </Card>
    </div>
  );
}
```
Ensure `me` is destructured from `useAuth()` (add `me` to the existing `const { can } = useAuth();` → `const { can, me } = useAuth();`).

- [ ] **Step 3: Typecheck** — `cd apps/web && npx tsc --noEmit` (clean).

- [ ] **Step 4: Commit**
```bash
git add "apps/web/app/(app)/channels/page.tsx"
git commit -m "feat(channels): New channel create modal"
```

## Task 7: Dashboards "New dashboard" modal

**Files:** Modify `apps/web/app/(app)/dashboards/page.tsx`

- [ ] **Step 1: RE-READ the page** (now also renders widgets from Task 5). Add `useAuth`, `Button`, `Input`, `Field` imports; add org sourcing like Task 6.

- [ ] **Step 2: Add button + modal**. Add to imports/state:
```tsx
import { Card, CardBody, Badge, Button, Input, Field } from '@/components/ui/primitives';
import { useAuth } from '@/components/auth-context';
import { dashboardsApi, type Dashboard } from '@/lib/api';
// state:
const { can, me } = useAuth();
const [creating, setCreating] = React.useState(false);
const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
const isAgent = !me?.organization_id;
React.useEffect(() => { if (isAgent) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {}); }, [isAgent]);
const canManage = can('dashboard.manage');
```
Header button (in the existing header flex row):
```tsx
{canManage && <Button onClick={() => setCreating(true)}>New dashboard</Button>}
```
Modal trigger + reload-and-select:
```tsx
{creating && (
  <NewDashboardModal orgs={orgs} isAgent={isAgent} onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); dashboardsApi.list().then((all) => { setList(all); setActive(all.find((x) => x.id === d.id) ?? d); }); }} />
)}
```
Modal component (append):
```tsx
const WIDGETS = ['kpis', 'ticket_volume', 'posture_gauge', 'top_findings', 'sla_breaches', 'recent_tickets'] as const;
const WIDGET_NAME: Record<string, string> = { kpis: 'KPI cards', ticket_volume: 'Ticket volume', posture_gauge: 'Posture gauge', top_findings: 'Top findings', sla_breaches: 'SLA', recent_tickets: 'Recent tickets' };

function NewDashboardModal({ orgs, isAgent, onClose, onCreated }: { orgs: { id: string; name: string }[]; isAgent: boolean; onClose: () => void; onCreated: (d: Dashboard) => void }) {
  const [name, setName] = React.useState('');
  const [organizationId, setOrganizationId] = React.useState('');
  const [picked, setPicked] = React.useState<string[]>(['kpis', 'recent_tickets']);
  const [err, setErr] = React.useState('');
  function toggle(w: string) { setPicked((p) => p.includes(w) ? p.filter((x) => x !== w) : [...p, w]); }
  async function save() {
    try {
      const d = await dashboardsApi.create({ name, layout: picked.map((type) => ({ type })), ...(isAgent ? { organizationId } : {}) });
      onCreated(d);
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardBody className="space-y-3">
          <h2 className="text-lg font-semibold">New dashboard</h2>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {isAgent && <Field label="Organization"><select className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}><option value="">Select…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
          <div><div className="mb-1 text-xs font-medium text-muted">Widgets</div>
            <div className="grid grid-cols-2 gap-1.5">
              {WIDGETS.map((w) => <label key={w} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(w)} onChange={() => toggle(w)} /> {WIDGET_NAME[w]}</label>)}
            </div>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name || picked.length === 0 || (isAgent && !organizationId)}>Create</Button></div>
        </CardBody>
      </Card>
    </div>
  );
}
```
(If `Select` from primitives is already imported on the page, use it instead of the raw `<select>` for the org picker to match style.)

- [ ] **Step 3: Typecheck** — `cd apps/web && npx tsc --noEmit` (clean).

- [ ] **Step 4: Commit**
```bash
git add "apps/web/app/(app)/dashboards/page.tsx"
git commit -m "feat(dashboards): New dashboard create modal (name + widget picker)"
```

---

## Self-Review

**1. Spec coverage:**
- Integration tests for alerts/channels/dashboards/services → Tasks 1–4 ✓ (dedup/transition/escalation in alerts; sanitizeLayout + default-delete guard in dashboards; CRUD + denial in services/channels). Tenant-isolation intentionally omitted (not cleanly assertable for nexus-admin features — noted in spec).
- Dashboard widgets render real data → Task 5 ✓ (kpis/sla/volume from one shared `overview`; posture/findings/recent self-fetch; empty card fallback).
- Channel + Dashboard create UIs → Tasks 6, 7 ✓ (inline modal pattern, org picker for nexus, existing client helpers, manage-gated).

**2. Placeholder scan:** No TBD/TODO. All code is concrete. "Confirm X / adapt if different" steps are guarded verification directives against real files, not placeholders.

**3. Type consistency:** `Overview` interface defined in `dashboard-widgets.tsx` (Task 5) and imported by the page; `DashboardWidget({ type, overview })` signature matches both call sites. `channelsApi.create`/`dashboardsApi.create`/`*.update`/`deleteDashboard` match the helpers added in the Phase 2 plan. `isAgent = !me?.organization_id` used consistently in Tasks 6 & 7. Test imports match exported module fn names (`createService`, `createChannel`, `createAlert`, `escalateAlert`, `createDashboard`, `deleteDashboard`, etc.). `describeDb`/`principalByEmail`/`loadPrincipal` copied verbatim from `queues.int.test.ts`.

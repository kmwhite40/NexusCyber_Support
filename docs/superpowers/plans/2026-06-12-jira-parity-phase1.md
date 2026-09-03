# Jira-Parity Phase 1 Implementation Plan (Wire-Ups)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose five features whose backend schema already exists — Queues, Services/CMDB, Customers, Email logs, and an Incidents view — as API + UI, and add their nav entries.

**Architecture:** Follow the existing module pattern exactly: an API module in `apps/api/src/modules/<f>.ts` using `withOrgContext`/`orgContextFor`/`authorize`/`audit`/`Errors`/`publish`; inline route registration in `apps/api/src/http/routes.ts`; client helpers in `apps/web/lib/api.ts`; a `'use client'` page under `apps/web/app/(app)/<f>/page.tsx` using shared primitives; nav entries in `apps/web/components/shell.tsx`. Pure filter/sort logic is extracted into testable functions (vitest unit tests, matching the repo's test style); CRUD wrappers and pages are gated on `npx tsc --noEmit`.

**Tech Stack:** Fastify + Postgres (RLS, `withOrgContext`) on the API; Next.js 14 App Router + Tailwind on the web; vitest for tests; npm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-11-jira-parity-features-design.md`

---

## Collision protocol (READ FIRST — concurrent process active)

Another agent commits to this branch and adds DB schema ahead of UI. For **every** task:
- Before creating a file, run `ls <path>` / read it. If it already exists, **extend it**, don't overwrite.
- Before editing `routes.ts`, `seed.ts`, `api.ts`, `shell.tsx`, re-read the current file (it may have changed) and splice your additions in; never paste over the whole file.
- `queue.manage` already exists in `seed.ts` — do NOT re-add it.
- The `queues`, `services`, `configuration_items`, `notification_deliveries`, `organizations` tables already exist — do NOT create migrations for them.
- Commit each task separately with `git add <specific files>` (never `git add -A`) so you never sweep the concurrent process's uncommitted work.
- Do NOT run `next build` while the dev server is live (corrupts `.next`). Web gate is `cd apps/web && npx tsc --noEmit`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/modules/queues.ts` | Queue CRUD + `buildQueueQuery` (pure) + run-against-tickets |
| `apps/api/src/modules/services.ts` | Services + configuration_items CRUD |
| `apps/api/test/queues.test.ts` | Unit tests for `buildQueueQuery` |
| `apps/api/src/http/routes.ts` (modify) | Register queues/services/customers/email-log routes |
| `apps/api/src/modules/accounts.ts` (modify) | Add org detail/update/users functions |
| `apps/api/src/modules/notifications.ts` (modify) | Add `listDeliveries` query |
| `apps/api/src/modules/tickets.ts` (modify) | Add `type` to list filter |
| `apps/api/src/db/seed.ts` (modify) | Add new permission keys + role grants |
| `apps/web/lib/api.ts` (modify) | Client helpers + interfaces for all five |
| `apps/web/app/(app)/queues/page.tsx` | Queues list + filtered ticket view |
| `apps/web/app/(app)/services/page.tsx` | Services + CIs registry |
| `apps/web/app/(app)/customers/page.tsx` | Customer org list + detail drawer |
| `apps/web/app/(app)/email-logs/page.tsx` | Notification delivery log |
| `apps/web/app/(app)/incidents/page.tsx` | Tickets filtered to type=incident |
| `apps/web/components/shell.tsx` (modify) | Nav entries + icons + titleFor cases |

---

## Task 1: Permission keys + role grants

**Files:**
- Modify: `apps/api/src/db/seed.ts`

- [ ] **Step 1: Re-read seed.ts permission catalog and role blocks**

Run: `grep -n "queue.manage\|permissions\|perms:" apps/api/src/db/seed.ts`
Confirm `['queue.manage', 'queue']` is present (do not duplicate it) and note the catalog array and role objects (Tier3/IncidentCommander, OrgAdmin, etc.).

- [ ] **Step 2: Add new permission keys to the catalog array**

In the permission catalog array (where entries like `['queue.manage', 'queue']` live), add these entries (skip any that already exist):

```ts
['queue.read', 'queue'],
['service.read', 'cmdb'],
['service.manage', 'cmdb'],
['org.read', 'org'],
['org.manage', 'org'],
['notifications.read', 'notifications'],
```

- [ ] **Step 3: Grant the new read/manage perms to the agent roles**

In the nexus agent role with the broadest grants (the block that already contains `'queue.manage'` — e.g. IncidentCommander/Tier3), append to its `perms` array:

```ts
'queue.read', 'service.read', 'service.manage', 'org.read', 'org.manage', 'notifications.read',
```

For read-only agent roles (e.g. Tier2/Tier1), append `'queue.read', 'service.read', 'org.read', 'notifications.read'` where appropriate. Do not grant any new key to customer-plane roles (OrgAdmin/EndUser/SecurityContact).

- [ ] **Step 4: Typecheck the API**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/seed.ts
git commit -m "feat(authz): add queue.read/service/org/notifications permissions + grants"
```

---

## Task 2: Queues — pure query compiler (TDD)

**Files:**
- Create: `apps/api/src/modules/queues.ts`
- Test: `apps/api/test/queues.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/queues.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildQueueQuery } from '../src/modules/queues.js';

describe('buildQueueQuery', () => {
  it('empty definition selects all (no filters), default sla order', () => {
    const q = buildQueueQuery({}, 'sla');
    expect(q.where).toBe('');
    expect(q.params).toEqual([]);
    expect(q.orderBy).toContain('sla_instances'); // soonest-breaching first
  });

  it('filters by status and priority with parameterized placeholders', () => {
    const q = buildQueueQuery({ status: 'open', priority: 'P1' }, 'priority');
    expect(q.where).toBe('WHERE t.status = $1 AND t.priority = $2');
    expect(q.params).toEqual(['open', 'P1']);
    expect(q.orderBy).toBe('ORDER BY t.priority ASC, t.created_at DESC');
  });

  it('unassigned:true adds an assignee IS NULL clause', () => {
    const q = buildQueueQuery({ unassigned: true }, 'created');
    expect(q.where).toBe('WHERE t.assignee_id IS NULL');
    expect(q.params).toEqual([]);
    expect(q.orderBy).toBe('ORDER BY t.created_at DESC');
  });

  it('tag filter matches the tags array', () => {
    const q = buildQueueQuery({ tag: 'vip' }, 'created');
    expect(q.where).toBe('WHERE $1 = ANY(t.tags)');
    expect(q.params).toEqual(['vip']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run test/queues.test.ts`
Expected: FAIL — cannot find module `queues.js` / `buildQueueQuery` is not a function.

- [ ] **Step 3: Implement `buildQueueQuery` (minimal) in a new module**

Create `apps/api/src/modules/queues.ts`:

```ts
// Saved agent work queues (JSM-style). A queue is a named ticket filter (queues table,
// migration 0014). buildQueueQuery compiles a queue definition into a parameterized
// WHERE/ORDER BY against the tickets table. Keep this pure for unit testing.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export interface QueueDefinition {
  status?: string;
  priority?: string;
  unassigned?: boolean;
  tag?: string;
}
export type QueueOrderBy = 'sla' | 'priority' | 'created';

export interface CompiledQuery {
  where: string;
  params: unknown[];
  orderBy: string;
}

/** Compile a queue definition + sort into a parameterized SQL fragment. Pure. */
export function buildQueueQuery(def: QueueDefinition, orderBy: QueueOrderBy): CompiledQuery {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (def.status) { params.push(def.status); clauses.push(`t.status = $${params.length}`); }
  if (def.priority) { params.push(def.priority); clauses.push(`t.priority = $${params.length}`); }
  if (def.unassigned) { clauses.push('t.assignee_id IS NULL'); }
  if (def.tag) { params.push(def.tag); clauses.push(`$${params.length} = ANY(t.tags)`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order =
    orderBy === 'priority' ? 'ORDER BY t.priority ASC, t.created_at DESC'
    : orderBy === 'created' ? 'ORDER BY t.created_at DESC'
    : 'ORDER BY (SELECT min(si.breach_at) FROM sla_instances si WHERE si.ticket_id = t.id) ASC NULLS LAST, t.created_at DESC';
  return { where, params, orderBy: order };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run test/queues.test.ts`
Expected: PASS (4 passing).

If the `sla` test fails because the column is not `breach_at`, run `grep -n "breach\|due_at" apps/api/src/db/migrations/0001_init.sql` to find the real SLA-instance breach column and update both the test's `toContain('sla_instances')` expectation and the `order` string to use it. Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/queues.ts apps/api/test/queues.test.ts
git commit -m "feat(queues): pure queue-definition query compiler + tests"
```

---

## Task 3: Queues — CRUD + run + routes + client + page

**Files:**
- Modify: `apps/api/src/modules/queues.ts`
- Modify: `apps/api/src/http/routes.ts`
- Modify: `apps/web/lib/api.ts`
- Create: `apps/web/app/(app)/queues/page.tsx`

- [ ] **Step 1: Add CRUD + run functions to `queues.ts`**

Append to `apps/api/src/modules/queues.ts`:

```ts
export async function listQueues(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT * FROM queues ORDER BY organization_id NULLS FIRST, name');
    return rows;
  });
}

export interface SaveQueueInput { name: string; definition?: QueueDefinition; orderBy?: QueueOrderBy; organizationId?: string | null; }

export async function createQueue(actor: Principal, input: SaveQueueInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : (input.organizationId ?? null);
  authorize(actor, 'queue.manage', orgId ? { organizationId: orgId } : {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO queues (organization_id, name, definition, order_by, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.name, JSON.stringify(input.definition ?? {}), input.orderBy ?? 'sla', actor.id],
    );
    await audit(actor, { action: 'queue.create', organizationId: orgId ?? undefined, resourceType: 'queue', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function updateQueue(actor: Principal, id: string, input: SaveQueueInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM queues WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('queue not found');
    authorize(actor, 'queue.manage', cur.organization_id ? { organizationId: cur.organization_id } : {});
    const { rows } = await sql.query(
      `UPDATE queues SET name=$1, definition=$2, order_by=$3 WHERE id=$4 RETURNING *`,
      [input.name ?? cur.name, JSON.stringify(input.definition ?? cur.definition), input.orderBy ?? cur.order_by, id],
    );
    await audit(actor, { action: 'queue.update', organizationId: cur.organization_id ?? undefined, resourceType: 'queue', resourceId: id });
    return rows[0];
  });
}

export async function deleteQueue(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM queues WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('queue not found');
    authorize(actor, 'queue.manage', cur.organization_id ? { organizationId: cur.organization_id } : {});
    await sql.query('DELETE FROM queues WHERE id=$1', [id]);
    await audit(actor, { action: 'queue.delete', organizationId: cur.organization_id ?? undefined, resourceType: 'queue', resourceId: id });
    return { ok: true };
  });
}

/** Run a queue: return the tickets matching its definition, in its sort order. */
export async function runQueue(actor: Principal, id: string, limit = 100) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const q = (await sql.query('SELECT * FROM queues WHERE id=$1', [id])).rows[0];
    if (!q) throw Errors.notFound('queue not found');
    const compiled = buildQueueQuery(q.definition as QueueDefinition, q.order_by as QueueOrderBy);
    const params = [...compiled.params, limit];
    const { rows } = await sql.query(
      `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.assignee_id, t.created_at
         FROM tickets t ${compiled.where} ${compiled.orderBy} LIMIT $${params.length}`,
      params,
    );
    return rows;
  });
}
```

- [ ] **Step 2: Register routes**

Re-read `apps/api/src/http/routes.ts`. After the `import * as problems` line add (if absent): `import * as queues from '../modules/queues.js';`. Inside `registerRoutes`, near the other resource routes, add:

```ts
app.get('/api/v1/queues', async (req) => ({ data: await queues.listQueues(principalOf(req)) }));
app.post('/api/v1/queues', async (req, reply) => { reply.code(201); return queues.createQueue(principalOf(req), req.body as any); });
app.patch('/api/v1/queues/:id', async (req) => queues.updateQueue(principalOf(req), (req.params as any).id, req.body as any));
app.delete('/api/v1/queues/:id', async (req) => queues.deleteQueue(principalOf(req), (req.params as any).id));
app.get('/api/v1/queues/:id/tickets', async (req) => ({ data: await queues.runQueue(principalOf(req), (req.params as any).id) }));
```

NOTE: use the SAME helper the surrounding routes use to get the principal (in the snippet above it is `principalOf(req)`; if the file uses a local like `const p = ...` per-route, match that exact style — `grep -n "Principal\|principalOf\|req.principal" apps/api/src/http/routes.ts` to confirm and adapt).

- [ ] **Step 3: Add client helpers + interface**

Re-read `apps/web/lib/api.ts`; after the `Ticket` interface add:

```ts
export interface Queue {
  id: string;
  organization_id: string | null;
  name: string;
  definition: { status?: string; priority?: string; unassigned?: boolean; tag?: string };
  order_by: 'sla' | 'priority' | 'created';
}
export const queuesApi = {
  list: () => api.get<{ data: Queue[] }>('/queues').then((r) => r.data),
  create: (b: Partial<Queue>) => api.post<Queue>('/queues', b),
  update: (id: string, b: Partial<Queue>) => api.patch<Queue>(`/queues/${id}`, b),
  remove: (id: string) => api.del<{ ok: true }>(`/queues/${id}`),
  tickets: (id: string) => api.get<{ data: Ticket[] }>(`/queues/${id}/tickets`).then((r) => r.data),
};
```

- [ ] **Step 4: Create the page**

Create `apps/web/app/(app)/queues/page.tsx`:

```tsx
'use client';
import React from 'react';
import Link from 'next/link';
import { queuesApi, type Queue, type Ticket } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Input, Select, Field } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

export default function QueuesPage() {
  const { can } = useAuth();
  const [queues, setQueues] = React.useState<Queue[] | null>(null);
  const [active, setActive] = React.useState<Queue | null>(null);
  const [tickets, setTickets] = React.useState<Ticket[] | null>(null);
  const [editing, setEditing] = React.useState(false);

  React.useEffect(() => { queuesApi.list().then(setQueues); }, []);
  React.useEffect(() => {
    if (!active) { setTickets(null); return; }
    setTickets(null);
    queuesApi.tickets(active.id).then(setTickets);
  }, [active]);

  const canManage = can('queue.manage');

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Queues</h1>
          <p className="mt-1 text-sm text-muted">Saved work queues across tickets.</p>
        </div>
        {canManage && <Button onClick={() => setEditing(true)}>New queue</Button>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Card>
          <CardBody className="space-y-1">
            {queues === null ? <Skeleton className="h-8" /> : queues.length === 0 ? (
              <EmptyState title="No queues yet" />
            ) : queues.map((q) => (
              <button
                key={q.id}
                onClick={() => setActive(q)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${active?.id === q.id ? 'bg-brand/15 text-brand' : 'hover:bg-surface-2 text-fg'}`}
              >
                {q.name}
                {q.organization_id === null && <span className="ml-2 text-xs text-muted">global</span>}
              </button>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            {!active ? (
              <EmptyState title="Select a queue" />
            ) : tickets === null ? (
              <Skeleton className="h-12" />
            ) : (
              <DataTable<Ticket>
                rows={tickets}
                columns={[
                  { key: 'ticket_number', header: 'Ticket', render: (t) => <Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link> },
                  { key: 'subject', header: 'Subject', render: (t) => t.subject },
                  { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
                  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
                ]}
                empty={<EmptyState title="No tickets match this queue" />}
              />
            )}
          </CardBody>
        </Card>
      </div>

      {editing && <QueueEditor onClose={() => setEditing(false)} onSaved={(q) => { setEditing(false); setQueues((qs) => [...(qs ?? []), q]); }} />}
    </div>
  );
}

function QueueEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (q: Queue) => void }) {
  const [name, setName] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [unassigned, setUnassigned] = React.useState(false);
  const [orderBy, setOrderBy] = React.useState<'sla' | 'priority' | 'created'>('sla');
  const [err, setErr] = React.useState('');

  async function save() {
    try {
      const definition: Queue['definition'] = {};
      if (status) definition.status = status;
      if (priority) definition.priority = priority;
      if (unassigned) definition.unassigned = true;
      const q = await queuesApi.create({ name, definition, order_by: orderBy });
      onSaved(q);
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardBody className="space-y-3">
          <h2 className="text-lg font-semibold">New queue</h2>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Status (optional)"><Input value={status} onChange={(e) => setStatus(e.target.value)} placeholder="open" /></Field>
          <Field label="Priority (optional)"><Input value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="P1" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unassigned} onChange={(e) => setUnassigned(e.target.checked)} /> Unassigned only</label>
          <Field label="Sort by">
            <Select value={orderBy} onChange={(e) => setOrderBy(e.target.value as any)}>
              <option value="sla">SLA (soonest breach)</option>
              <option value="priority">Priority</option>
              <option value="created">Newest</option>
            </Select>
          </Field>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name}>Create</Button></div>
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck both workspaces**

Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: no errors. If `DataTable`/`PriorityBadge`/`StatusBadge` prop names differ, run `grep -n "export" apps/web/components/ui/data.tsx apps/web/components/ui/badges.tsx` and adjust the page to the real signatures.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/queues.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/queues/page.tsx"
git commit -m "feat(queues): CRUD + run API, client, and /queues page"
```

---

## Task 4: Services / CMDB — module + routes + client + page

**Files:**
- Create: `apps/api/src/modules/services.ts`
- Modify: `apps/api/src/http/routes.ts`, `apps/web/lib/api.ts`
- Create: `apps/web/app/(app)/services/page.tsx`

- [ ] **Step 1: Confirm the table columns**

Run: `grep -n "services\|configuration_items" apps/api/src/db/migrations/0001_init.sql`
Confirm columns: `services(id, organization_id, name, kind)` and `configuration_items(id, organization_id, ci_class, name, criticality, status)`. If they differ, adapt the SQL below to the real columns.

- [ ] **Step 2: Create `services.ts`**

Create `apps/api/src/modules/services.ts`:

```ts
// Services & CMDB registry. Surfaces the services + configuration_items tables (0001),
// which tickets reference via service_id / ci_id. CRUD with org isolation via RLS.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export async function listServices(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT s.*, (SELECT count(*)::int FROM tickets t WHERE t.service_id = s.id) AS ticket_count
         FROM services s ORDER BY s.name`,
    );
    return rows;
  });
}

export interface SaveServiceInput { name: string; kind?: string; organizationId?: string; }

export async function createService(actor: Principal, input: SaveServiceInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'service.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO services (organization_id, name, kind) VALUES ($1,$2,$3) RETURNING *`,
      [orgId, input.name, input.kind ?? 'application'],
    );
    await audit(actor, { action: 'service.create', organizationId: orgId, resourceType: 'service', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function listConfigurationItems(actor: Principal, filter: { ciClass?: string; status?: string } = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.ciClass) { params.push(filter.ciClass); where.push(`ci_class = $${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    const { rows } = await sql.query(
      `SELECT ci.*, (SELECT count(*)::int FROM tickets t WHERE t.ci_id = ci.id) AS ticket_count
         FROM configuration_items ci ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ci.criticality DESC NULLS LAST, ci.name`,
      params,
    );
    return rows;
  });
}

export interface SaveCiInput { name: string; ciClass: string; criticality?: string; status?: string; organizationId?: string; }

export async function createConfigurationItem(actor: Principal, input: SaveCiInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'service.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO configuration_items (organization_id, ci_class, name, criticality, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.ciClass, input.name, input.criticality ?? 'medium', input.status ?? 'active'],
    );
    await audit(actor, { action: 'cmdb.ci.create', organizationId: orgId, resourceType: 'configuration_item', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}
```

- [ ] **Step 3: Register routes** (re-read routes.ts; add `import * as services from '../modules/services.js';` and, matching the file's principal-access style):

```ts
app.get('/api/v1/services', async (req) => ({ data: await services.listServices(principalOf(req)) }));
app.post('/api/v1/services', async (req, reply) => { reply.code(201); return services.createService(principalOf(req), req.body as any); });
app.get('/api/v1/configuration-items', async (req) => ({ data: await services.listConfigurationItems(principalOf(req), req.query as any) }));
app.post('/api/v1/configuration-items', async (req, reply) => { reply.code(201); return services.createConfigurationItem(principalOf(req), req.body as any); });
```

- [ ] **Step 4: Add client helpers** (re-read api.ts; append):

```ts
export interface ServiceRow { id: string; organization_id: string; name: string; kind: string; ticket_count: number; }
export interface ConfigurationItem { id: string; organization_id: string; ci_class: string; name: string; criticality: string; status: string; ticket_count: number; }
export const servicesApi = {
  list: () => api.get<{ data: ServiceRow[] }>('/services').then((r) => r.data),
  create: (b: { name: string; kind?: string; organizationId?: string }) => api.post<ServiceRow>('/services', b),
  cis: (q = '') => api.get<{ data: ConfigurationItem[] }>(`/configuration-items${q}`).then((r) => r.data),
  createCi: (b: { name: string; ciClass: string; criticality?: string; status?: string; organizationId?: string }) => api.post<ConfigurationItem>('/configuration-items', b),
};
```

- [ ] **Step 5: Create the page** `apps/web/app/(app)/services/page.tsx`:

```tsx
'use client';
import React from 'react';
import { servicesApi, type ServiceRow, type ConfigurationItem } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { Badge } from '@/components/ui/primitives';

export default function ServicesPage() {
  const [tab, setTab] = React.useState<'services' | 'cis'>('services');
  const [services, setServices] = React.useState<ServiceRow[] | null>(null);
  const [cis, setCis] = React.useState<ConfigurationItem[] | null>(null);

  React.useEffect(() => { servicesApi.list().then(setServices); servicesApi.cis().then(setCis); }, []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Services &amp; assets</h1>
        <p className="mt-1 text-sm text-muted">Service registry and configuration items (CMDB).</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Services" value={services?.length ?? '—'} />
        <StatCard label="Configuration items" value={cis?.length ?? '—'} />
      </div>
      <div className="flex gap-2">
        <button onClick={() => setTab('services')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'services' ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-surface-2'}`}>Services</button>
        <button onClick={() => setTab('cis')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'cis' ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-surface-2'}`}>Configuration items</button>
      </div>
      <Card><CardBody>
        {tab === 'services' ? (
          services === null ? <Skeleton className="h-12" /> : (
            <DataTable<ServiceRow>
              rows={services}
              columns={[
                { key: 'name', header: 'Service', render: (s) => s.name },
                { key: 'kind', header: 'Kind', render: (s) => <Badge>{s.kind}</Badge> },
                { key: 'ticket_count', header: 'Tickets', render: (s) => s.ticket_count },
              ]}
              empty={<EmptyState title="No services registered" />}
            />
          )
        ) : (
          cis === null ? <Skeleton className="h-12" /> : (
            <DataTable<ConfigurationItem>
              rows={cis}
              columns={[
                { key: 'name', header: 'CI', render: (c) => c.name },
                { key: 'ci_class', header: 'Class', render: (c) => <Badge>{c.ci_class}</Badge> },
                { key: 'criticality', header: 'Criticality', render: (c) => c.criticality },
                { key: 'status', header: 'Status', render: (c) => c.status },
                { key: 'ticket_count', header: 'Tickets', render: (c) => c.ticket_count },
              ]}
              empty={<EmptyState title="No configuration items" />}
            />
          )
        )}
      </CardBody></Card>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit` (fix prop mismatches against `data.tsx` if any).

```bash
git add apps/api/src/modules/services.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/services/page.tsx"
git commit -m "feat(cmdb): services + configuration-items API, client, and /services page"
```

---

## Task 5: Customers — org detail/update/users + routes + client + page

**Files:**
- Modify: `apps/api/src/modules/accounts.ts`, `apps/api/src/http/routes.ts`, `apps/web/lib/api.ts`
- Create: `apps/web/app/(app)/customers/page.tsx`

- [ ] **Step 1: Confirm organizations columns**

Run: `grep -n "CREATE TABLE organizations" -A 12 apps/api/src/db/migrations/0001_init.sql`
Note the editable columns (e.g. `name`, `cloud_tier`, `data_boundary`, `enclave`). Adapt the SQL below to the real column names.

- [ ] **Step 2: Add functions to `accounts.ts`** (re-read it first; append, reusing its existing imports for `withOrgContext`/`authorize`/`audit`/`Errors`):

```ts
export async function getOrganization(actor: Principal, id: string) {
  authorize(actor, 'org.read', { organizationId: id });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const org = (await sql.query('SELECT * FROM organizations WHERE id=$1', [id])).rows[0];
    if (!org) throw Errors.notFound('organization not found');
    const userCount = (await sql.query('SELECT count(*)::int AS n FROM users WHERE organization_id=$1', [id])).rows[0].n;
    const openTickets = (await sql.query(`SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1 AND status NOT IN ('closed','resolved')`, [id])).rows[0].n;
    return { ...org, user_count: userCount, open_tickets: openTickets };
  });
}

export async function listOrganizationUsers(actor: Principal, id: string) {
  authorize(actor, 'org.read', { organizationId: id });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT id, email, display_name, status FROM users WHERE organization_id=$1 ORDER BY email', [id]);
    return rows;
  });
}

export interface UpdateOrgInput { name?: string; cloudTier?: string; dataBoundary?: string; }

export async function updateOrganization(actor: Principal, id: string, input: UpdateOrgInput) {
  authorize(actor, 'org.manage', { organizationId: id });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM organizations WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('organization not found');
    const { rows } = await sql.query(
      `UPDATE organizations SET name=$1, cloud_tier=$2, data_boundary=$3 WHERE id=$4 RETURNING *`,
      [input.name ?? cur.name, input.cloudTier ?? cur.cloud_tier, input.dataBoundary ?? cur.data_boundary, id],
    );
    await audit(actor, { action: 'org.update', organizationId: id, resourceType: 'organization', resourceId: id });
    return rows[0];
  });
}
```

If `accounts.ts` does not already import `orgContextFor`, add it to its imports.

- [ ] **Step 3: Register routes** (re-read routes.ts; `accounts` is likely already imported):

```ts
app.get('/api/v1/organizations/:id', async (req) => accounts.getOrganization(principalOf(req), (req.params as any).id));
app.patch('/api/v1/organizations/:id', async (req) => accounts.updateOrganization(principalOf(req), (req.params as any).id, req.body as any));
app.get('/api/v1/organizations/:id/users', async (req) => ({ data: await accounts.listOrganizationUsers(principalOf(req), (req.params as any).id) }));
```

(Confirm `accounts.getOrganization` etc. are exported under whatever namespace the file imports accounts as.)

- [ ] **Step 4: Client helpers** (append to api.ts):

```ts
export interface OrgDetail { id: string; name: string; cloud_tier: string; data_boundary?: string; user_count: number; open_tickets: number; }
export interface OrgUser { id: string; email: string; display_name: string | null; status: string; }
export interface OrgSummary { id: string; name: string; cloud_tier?: string; }
export const customersApi = {
  list: () => api.get<{ data: OrgSummary[] } | OrgSummary[]>('/organizations').then((r) => Array.isArray(r) ? r : r.data),
  get: (id: string) => api.get<OrgDetail>(`/organizations/${id}`),
  users: (id: string) => api.get<{ data: OrgUser[] }>(`/organizations/${id}/users`).then((r) => r.data),
  update: (id: string, b: { name?: string; cloudTier?: string; dataBoundary?: string }) => api.patch<OrgDetail>(`/organizations/${id}`, b),
};
```

NOTE: `GET /organizations` already exists; verify whether it returns a bare array or `{ data }` (`grep -n "organizations'" apps/api/src/http/routes.ts`) and keep the `Array.isArray` guard above accordingly.

- [ ] **Step 5: Create the page** `apps/web/app/(app)/customers/page.tsx`:

```tsx
'use client';
import React from 'react';
import { customersApi, type OrgSummary, type OrgDetail, type OrgUser } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function CustomersPage() {
  const [orgs, setOrgs] = React.useState<OrgSummary[] | null>(null);
  const [detail, setDetail] = React.useState<OrgDetail | null>(null);
  const [users, setUsers] = React.useState<OrgUser[] | null>(null);

  React.useEffect(() => { customersApi.list().then(setOrgs); }, []);

  function open(id: string) {
    setDetail(null); setUsers(null);
    customersApi.get(id).then(setDetail);
    customersApi.users(id).then(setUsers);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="mt-1 text-sm text-muted">Customer organizations and their users.</p>
      </div>
      <Card><CardBody>
        {orgs === null ? <Skeleton className="h-12" /> : (
          <DataTable<OrgSummary>
            rows={orgs}
            columns={[
              { key: 'name', header: 'Organization', render: (o) => <button className="text-brand hover:underline" onClick={() => open(o.id)}>{o.name}</button> },
              { key: 'cloud_tier', header: 'Cloud', render: (o) => o.cloud_tier ?? '—' },
            ]}
            empty={<EmptyState title="No customers" />}
          />
        )}
      </CardBody></Card>

      {detail && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <CardBody className="space-y-3">
              <h2 className="text-lg font-semibold">{detail.name}</h2>
              <div className="flex gap-6 text-sm text-muted">
                <span>Cloud: <span className="text-fg">{detail.cloud_tier}</span></span>
                <span>Users: <span className="text-fg">{detail.user_count}</span></span>
                <span>Open tickets: <span className="text-fg">{detail.open_tickets}</span></span>
              </div>
              {users === null ? <Skeleton className="h-10" /> : (
                <DataTable<OrgUser>
                  rows={users}
                  columns={[
                    { key: 'email', header: 'Email', render: (u) => u.email },
                    { key: 'display_name', header: 'Name', render: (u) => u.display_name ?? '—' },
                    { key: 'status', header: 'Status', render: (u) => u.status },
                  ]}
                  empty={<EmptyState title="No users" />}
                />
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit`

```bash
git add apps/api/src/modules/accounts.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/customers/page.tsx"
git commit -m "feat(customers): org detail/update/users API, client, and /customers page"
```

---

## Task 6: Email logs — delivery query + route + client + page

**Files:**
- Modify: `apps/api/src/modules/notifications.ts`, `apps/api/src/http/routes.ts`, `apps/web/lib/api.ts`
- Create: `apps/web/app/(app)/email-logs/page.tsx`

- [ ] **Step 1: Confirm columns**

Run: `grep -n "CREATE TABLE notification_deliveries" -A 14 apps/api/src/db/migrations/0001_init.sql; grep -n "notification_deliveries" apps/api/src/db/migrations/0011*.sql`
Note columns: `event_type, channel, recipient, status, substitution_reason, provider_message_id, created_at` (+ any org column).

- [ ] **Step 2: Add `listDeliveries` to `notifications.ts`** (re-read it; append, reusing existing imports):

```ts
export interface DeliveryFilter { channel?: string; status?: string; eventType?: string; limit?: number; }

export async function listDeliveries(actor: Principal, filter: DeliveryFilter = {}) {
  authorize(actor, 'notifications.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.channel) { params.push(filter.channel); where.push(`channel = $${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    if (filter.eventType) { params.push(filter.eventType); where.push(`event_type = $${params.length}`); }
    params.push(Math.min(filter.limit ?? 200, 500));
    const { rows } = await sql.query(
      `SELECT * FROM notification_deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  });
}
```

If `notifications.ts` lacks imports for `authorize`/`orgContextFor`/`Principal`, add them (mirror `problems.ts`).

- [ ] **Step 3: Register route** (re-read routes.ts; `notifications` may not be imported yet — add `import * as notifications from '../modules/notifications.js';` if absent):

```ts
app.get('/api/v1/notifications/deliveries', async (req) => ({ data: await notifications.listDeliveries(principalOf(req), req.query as any) }));
```

- [ ] **Step 4: Client helper** (append to api.ts):

```ts
export interface Delivery { id: string; event_type: string; channel: string; recipient: string; status: string; substitution_reason: string | null; provider_message_id: string | null; created_at: string; }
export const emailLogApi = {
  list: (q = '') => api.get<{ data: Delivery[] }>(`/notifications/deliveries${q}`).then((r) => r.data),
};
```

- [ ] **Step 5: Create the page** `apps/web/app/(app)/email-logs/page.tsx`:

```tsx
'use client';
import React from 'react';
import { emailLogApi, type Delivery } from '@/lib/api';
import { Card, CardBody, Select, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function EmailLogsPage() {
  const [rows, setRows] = React.useState<Delivery[] | null>(null);
  const [channel, setChannel] = React.useState('');
  const [status, setStatus] = React.useState('');

  React.useEffect(() => {
    const params = new URLSearchParams();
    if (channel) params.set('channel', channel);
    if (status) params.set('status', status);
    const q = params.toString();
    setRows(null);
    emailLogApi.list(q ? `?${q}` : '').then(setRows);
  }, [channel, status]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email &amp; notification logs</h1>
        <p className="mt-1 text-sm text-muted">Delivery history across channels.</p>
      </div>
      <div className="flex gap-3">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option><option value="email">Email</option><option value="teams">Teams</option><option value="portal">Portal</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="sent">Sent</option><option value="failed">Failed</option><option value="skipped">Skipped</option><option value="substituted">Substituted</option>
        </Select>
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Delivery>
            rows={rows}
            columns={[
              { key: 'created_at', header: 'Time', render: (d) => new Date(d.created_at).toLocaleString() },
              { key: 'event_type', header: 'Event', render: (d) => d.event_type },
              { key: 'channel', header: 'Channel', render: (d) => <Badge>{d.channel}</Badge> },
              { key: 'recipient', header: 'Recipient', render: (d) => d.recipient },
              { key: 'status', header: 'Status', render: (d) => d.status },
            ]}
            empty={<EmptyState title="No deliveries logged" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit`

```bash
git add apps/api/src/modules/notifications.ts apps/api/src/http/routes.ts apps/web/lib/api.ts "apps/web/app/(app)/email-logs/page.tsx"
git commit -m "feat(notifications): delivery log query API, client, and /email-logs page"
```

---

## Task 7: Incidents view — ticket type filter + page

**Files:**
- Modify: `apps/api/src/modules/tickets.ts` (only if `type` filter is absent)
- Create: `apps/web/app/(app)/incidents/page.tsx`

- [ ] **Step 1: Check whether `listTickets` supports a `type` filter**

Run: `grep -n "ListFilter\|type\b\|status\b" apps/api/src/modules/tickets.ts | head`
If the `ListFilter` interface and `listTickets` already accept `type`, skip Step 2.

- [ ] **Step 2: Add `type` to the ticket list filter (only if missing)**

In `apps/api/src/modules/tickets.ts`, add `type?: string;` to the `ListFilter` interface, and in `listTickets` where other filters are appended, add:

```ts
if (filter.type) { params.push(filter.type); where.push(`type = $${params.length}`); }
```

(Match the exact variable names used in that function — re-read it first.)

- [ ] **Step 3: Confirm the tickets route forwards query filters**

Run: `grep -n "tickets'" apps/api/src/http/routes.ts`
The existing `GET /api/v1/tickets` passes `req.query` to `listTickets`. If `type` is now in `ListFilter`, `?type=incident` works with no route change. If the route hand-picks specific query keys, add `type` to that pick list.

- [ ] **Step 4: Create the page** `apps/web/app/(app)/incidents/page.tsx`:

```tsx
'use client';
import React from 'react';
import Link from 'next/link';
import { api, type Ticket } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { PriorityBadge, StatusBadge } from '@/components/ui/badges';

export default function IncidentsPage() {
  const [rows, setRows] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => {
    api.get<{ data: Ticket[] }>('/tickets?type=incident&limit=200').then((r) => setRows(r.data));
  }, []);
  const open = (rows ?? []).filter((t) => t.status !== 'closed' && t.status !== 'resolved').length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
        <p className="mt-1 text-sm text-muted">Tickets of type incident.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Open incidents" value={rows === null ? '—' : open} />
        <StatCard label="Total" value={rows === null ? '—' : rows.length} />
      </div>
      <Card><CardBody>
        {rows === null ? <Skeleton className="h-12" /> : (
          <DataTable<Ticket>
            rows={rows}
            columns={[
              { key: 'ticket_number', header: 'Incident', render: (t) => <Link className="text-brand hover:underline" href={`/tickets/${t.id}`}>{t.ticket_number}</Link> },
              { key: 'subject', header: 'Subject', render: (t) => t.subject },
              { key: 'priority', header: 'Priority', render: (t) => <PriorityBadge priority={t.priority} /> },
              { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            ]}
            empty={<EmptyState title="No incidents" />}
          />
        )}
      </CardBody></Card>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit`

```bash
git add apps/api/src/modules/tickets.ts "apps/web/app/(app)/incidents/page.tsx"
git commit -m "feat(incidents): type filter on tickets + /incidents view"
```

---

## Task 8: Nav entries for the five new pages

**Files:**
- Modify: `apps/web/components/shell.tsx`

- [ ] **Step 1: Re-read shell.tsx**

Run: `grep -n "NEXUS_NAV\|titleFor\|function Icon" apps/web/components/shell.tsx`
Confirm the `NEXUS_NAV` array, the `titleFor()` switch, and where inline `Icon*` SVG functions are defined.

- [ ] **Step 2: Add five nav items to `NEXUS_NAV`**

Insert into `NEXUS_NAV` (reuse existing icons to avoid new SVGs; pick the closest existing `Icon*`):

```tsx
{ href: '/queues', label: 'Queues', icon: <IconTicket />, anyPerm: ['queue.read', 'queue.manage'] },
{ href: '/incidents', label: 'Incidents', icon: <IconBug /> },
{ href: '/services', label: 'Services', icon: <IconGrid />, anyPerm: ['service.read', 'service.manage'] },
{ href: '/customers', label: 'Customers', icon: <IconCatalog />, anyPerm: ['org.read', 'org.manage'] },
{ href: '/email-logs', label: 'Email logs', icon: <IconScroll />, anyPerm: ['notifications.read'] },
```

(If any `Icon*` referenced above doesn't exist, run the grep from Step 1 and substitute an existing one.)

- [ ] **Step 3: Add `titleFor()` cases**

In the `titleFor()` function, add cases:

```ts
if (path.startsWith('/queues')) return 'Queues';
if (path.startsWith('/incidents')) return 'Incidents';
if (path.startsWith('/services')) return 'Services & assets';
if (path.startsWith('/customers')) return 'Customers';
if (path.startsWith('/email-logs')) return 'Email logs';
```

(Match the file's existing `titleFor` style — it may use a switch or sequential `if`s.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke (human/controller, dev server already running)**

Visit `/queues`, `/incidents`, `/services`, `/customers`, `/email-logs`. Each should render its page (empty states are fine on seed data). Confirm nav items appear for an agent account.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/shell.tsx
git commit -m "feat(nav): surface queues, incidents, services, customers, email-logs"
```

---

## Self-Review

**1. Spec coverage (Phase 1 scope):**
- Queues (API + run + UI + Filters fold-in) → Tasks 2, 3, 8 ✓
- Services/CMDB (API + UI) → Tasks 4, 8 ✓
- Customers (org detail/update/users + UI) → Tasks 5, 8 ✓
- Email logs (query + UI) → Tasks 6, 8 ✓
- Incidents (type filter + view) → Tasks 7, 8 ✓
- Permissions added + granted → Task 1 ✓
- Collision protocol (verify-before-edit, surgical `git add`, no `next build`) → top section + every task's re-read step ✓
- Phase 2 (Alerts, Channels, Dashboards) and Phase 3 (nav restructure into sections, Get started, Archived) are intentionally OUT of this plan — they get their own plans after Phase 1 lands.

**2. Placeholder scan:** No TBD/TODO. Every code step has complete code. The only conditional steps ("only if missing") are guarded by an explicit grep check with a defined fallback — not placeholders.

**3. Type consistency:** `buildQueueQuery(def, orderBy)` returns `{ where, params, orderBy }` and is consumed identically in `runQueue` (Task 2 → Task 3). `QueueDefinition` fields (`status`/`priority`/`unassigned`/`tag`) match the `0014` migration jsonb and the client `Queue.definition` interface. Client helper namespaces (`queuesApi`, `servicesApi`, `customersApi`, `emailLogApi`) are referenced only by their own pages. Route handlers use `principalOf(req)` as a placeholder for the file's actual principal accessor — every route task flags this with a grep to confirm and adapt to the real style. SQL column names (`assignee_id`, `tags`, `service_id`, `ci_id`, `cloud_tier`, `data_boundary`, `event_type`) are each gated by a "confirm columns" grep step so they're corrected to reality before use.

# Jira-Parity Feature Build — Design Spec

**Date:** 2026-06-11
**Status:** Approved (design), pending spec review
**Branch:** `feat/nexus-platform` (same-branch, frequent commits)

## Goal

Bring the Nexus app's navigation and feature set to parity with the reference
Jira Service Management sidebar (Service project + Operations). Surface
existing-but-unexposed backend, wire up tables the concurrent process already
created, build the genuinely missing subsystems, and restructure the nav to
mirror Jira's grouping — **without duplicating** anything that already exists.

## Audit baseline (what already exists — do NOT rebuild)

- **On-call schedules** — complete (`oncall.ts`, six tables, full UI).
- **Reports** — `analytics.ts` overview + `/analytics`.
- **Knowledge Base** — `kb.ts`, tables `0009`, `/kb`.
- **Summary** — the existing single `/dashboard`.
- **Service requests** — Tickets + Service Catalog.

N/A (Jira UI affordances, not features): Add shortcut, More spaces, Multi-space work.

## Collision protocol (concurrent process active)

Another agent is building features on this branch and lays DB schema ahead of
UI (it added `queues` `0014` and `csat` `0013` this session). Therefore:

- Before editing any file, re-check `git status` / re-read the file; if it
  changed since last read, reconcile before writing.
- Never recreate a table that already exists — build the API/UI on top of it.
- Commit each feature in small, self-contained commits so conflicts are local.
- Migrations use the next free sequential number at creation time; if a number
  collides, renumber to the next free slot.

---

## Feature specs

Shared conventions (reused for every feature):
- **API:** a module in `apps/api/src/modules/<feature>.ts`; routes registered in
  `apps/api/src/http/routes.ts` under `/api/v1/...`; tenant-scoped via the org
  guard; permission-gated.
- **Client:** typed helpers added to `apps/web/lib/api.ts`.
- **UI:** `'use client'` page at `apps/web/app/(app)/<feature>/page.tsx` using
  `Card`/`CardBody`, `DataTable<T>`, `StatCard`, `Badge`, `EmptyState`,
  `Skeleton`, modals as inline `fixed inset-0 ...` components.
- **Nav:** entry in `NEXUS_NAV` (and `CUSTOMER_NAV` where relevant) in
  `shell.tsx` with `anyPerm`; add a `titleFor()` case and an inline SVG icon.
- **Permissions:** new keys added to the permissions catalog and mapped to roles.

### Phase 1 — wire up existing schema

#### 1. Customers (`/customers`)
- **Existing:** `accounts.ts` (`GET /organizations`, user provisioning),
  `organizations` + `users` tables.
- **API (new):** `GET /api/v1/organizations/:id` (detail incl. cloud tier, data
  boundary, enclave), `PATCH /api/v1/organizations/:id` (name, cloud tier, data
  boundary), `GET /api/v1/organizations/:id/users` (org roster).
- **UI:** table of customer orgs (name, tier, #users, open tickets, posture
  score); row opens a detail drawer with users and quick stats; org-admins can
  edit org settings.
- **Permissions:** `org.read`, `org.manage`.

#### 2. Services / CMDB (`/services`)
- **Existing:** `services`, `configuration_items` tables; tickets FK to them.
- **API (new):** `services.ts` — `GET/POST/PATCH /api/v1/services`,
  `GET/POST/PATCH /api/v1/configuration-items` (filter by class/criticality/
  status), `DELETE` (soft). List endpoints include linked-ticket counts.
- **UI:** two-tab registry (Services | Configuration Items) as `DataTable`s;
  CI detail shows criticality, status, and related tickets.
- **Permissions:** `service.read`, `service.manage`.

#### 3. Email logs (`/email-logs`)
- **Existing:** `notification_deliveries` (written on every dispatch),
  `notification_preferences`.
- **API (new):** `GET /api/v1/notifications/deliveries` (filters: channel,
  status, event_type, recipient, date range; paginated). Read-only.
- **UI:** filterable log table (time, event, channel, recipient, status,
  substitution reason, provider message id).
- **Permissions:** `notifications.read` (falls back to `audit.read`).

#### 4. Queues (`/queues`)  ⚠️ highest collision risk
- **Existing:** `queues` table (`0014`) — `definition` jsonb (status, priority,
  unassigned, tag), `order_by`, optional `organization_id` (NULL = global).
- **API (new):** `queues.ts` — `GET/POST/PATCH/DELETE /api/v1/queues`, and
  `GET /api/v1/queues/:id/tickets` which executes the queue's `definition`
  against the tickets query layer (reusing `listTickets` filter logic).
- **UI:** queue list (name, scope, live count); selecting a queue renders the
  existing ticket `DataTable` filtered by the queue definition. A queue editor
  modal builds the `definition` (status/priority/unassigned/tag) and `order_by`.
- **Folds in "Filters":** a personal saved filter is a `queues` row scoped to
  the user; no separate entity.
- **Permissions:** `queue.read`, `queue.manage`.
- **Collision note:** before creating `queues.ts` or touching `0014`, verify the
  concurrent process hasn't already added them; if so, extend rather than create.

#### 5. Incidents (`/incidents`)
- **Existing:** `type='incident'` discriminator on tickets.
- **API:** none new — reuse `GET /api/v1/tickets` with a `type` filter (add
  `type` to the existing `ListFilter` if absent).
- **UI:** a tickets view pre-filtered to `type='incident'`; ships as a built-in
  global queue once #4 exists, plus its own nav entry. Optional `severity`
  surfacing (column exists, currently unused).
- **Permissions:** existing ticket read perms.

### Phase 2 — net-new subsystems

#### 6. Alerts (`/alerts`) — **new entity, can escalate**
- **Data (new migration):** `alerts` table — `id`, `organization_id`, `source`
  (e.g. defender/sentinel/manual), `dedup_key`, `severity`, `state`
  (`triggered`→`acknowledged`→`resolved`), `summary`, `details` jsonb,
  `created_at`, `acknowledged_at`, `resolved_at`, `acknowledged_by`, and nullable
  `escalated_page_id` / `escalated_ticket_id`. Unique-ish on
  `(organization_id, dedup_key, state in (triggered,acknowledged))` to dedup
  open alerts.
- **API (new):** `alerts.ts` — `GET /api/v1/alerts` (filter state/severity/
  source), `POST /api/v1/alerts` (ingest/create + dedup), `POST
  /api/v1/alerts/:id/ack`, `POST /api/v1/alerts/:id/resolve`, `POST
  /api/v1/alerts/:id/escalate` (creates an on-call page via `oncall` and/or a
  ticket via `tickets`, storing the back-references). Emits notifications via
  the existing `notifications.ts` event bus.
- **UI:** alert feed `DataTable` (severity, summary, source, state, age) with
  Ack / Resolve / Escalate actions; stat cards (open/triggered/acknowledged).
- **Permissions:** `alert.read`, `alert.ack`, `alert.manage`.

#### 7. Channels (`/channels`)
- **Data (new migration):** `channels` table — `id`, `organization_id`, `type`
  (`email`/`portal`/`widget`), `name`, `config` jsonb (e.g. email address,
  widget key), `enabled`, timestamps.
- **API (new):** `channels.ts` — `GET/POST/PATCH/DELETE /api/v1/channels`.
- **UI:** channel list + config modal per type; enable/disable toggle. The
  ticket `source_channel` string is reconciled to reference a configured channel
  where one matches (no destructive migration of existing values).
- **Permissions:** `channel.read`, `channel.manage`.

#### 8. Dashboards (`/dashboards`) — **named, preset widgets**
- **Data (new migration):** `dashboards` table — `id`, `organization_id`,
  `owner_user_id` (nullable = shared), `name`, `layout` jsonb (ordered list of
  widget descriptors chosen from a fixed library), `is_default`, timestamps.
- **Widget library (fixed):** KPI cards, ticket volume sparkline, posture
  gauge + severity bars, top posture findings, SLA breach summary, recent
  tickets. Each widget is backed by an existing analytics/posture/SLA query.
- **API (new):** extend `analytics.ts` or new `dashboards.ts` —
  `GET/POST/PATCH/DELETE /api/v1/dashboards`, plus per-widget data endpoints
  (reuse existing `analytics/overview`, posture, SLA queries).
- **UI:** `/dashboards` lists named dashboards with `+` create and "view all";
  a dashboard renders its `layout` widgets. The current fixed `/dashboard`
  becomes the seeded default "Operations overview."
- **Permissions:** `dashboard.read`, `dashboard.manage`.

### Phase 3 — IA / nav restructure

`shell.tsx` gains **section grouping** (currently flat arrays). Target staff nav:

```
Get started
— Work —
  Summary (Dashboard)
  Queues
  Service requests (Catalog)
  Incidents
  Tickets
  Changes
  Problems
  Knowledge Base
  Archived work items
— Operations —
  On-call
  Alerts
  Services
  Reports (Analytics)
  Customers
— Insights —
  Filters (saved queues)
  Dashboards
Posture · Compliance · Automations · Audit log   (Nexus-specific, retained)
```

- `NavItem` gains an optional section; render groups with small uppercase
  headers (matching the Jira layout). Customer nav stays lean (portal-focused).
- **Get started:** a lightweight in-app surface (links to key actions / setup
  checklist), not a wizard.
- **Archived work items:** a tickets view filtered to closed/archived (+ a way
  to browse archived KB pages, which `kb.ts` already supports transitioning to).

---

## Permissions to add

`org.read`, `org.manage`, `service.read`, `service.manage`, `notifications.read`,
`queue.read`, `queue.manage`, `alert.read`, `alert.ack`, `alert.manage`,
`channel.read`, `channel.manage`, `dashboard.read`, `dashboard.manage`. Add to
the permissions catalog migration and map to existing roles (OrgAdmin/agent
tiers get manage; read for broader roles). Customer-plane users get none of the
operations/admin keys.

## Testing

Per feature, following the repo's existing API test pattern (`apps/api/test/
<feature>.test.ts`, integration tests under `test/integration/`):
- API: CRUD happy-path + tenant isolation (an org cannot read another org's
  rows) + permission denial.
- Queue/alert logic: queue `definition` executes correctly; alert dedup + state
  transitions + escalation create the linked page/ticket.
- Web: typecheck (`npx tsc --noEmit`) is the gate for pages (no component test
  harness). Do NOT run `next build` while the dev server is live (corrupts
  `.next`; see project memory).

## Phasing & ordering

Build in order 1→9. Phase 1 (1–5) first: additive, mostly wiring existing
schema, lowest collision risk (Queues excepted). Phase 2 (6–8) net-new. Phase 3
(9) nav last, once routes exist to link. Each numbered feature is its own set of
commits; the implementation plan will break each into bite-sized tasks.

## Non-goals

- No alert source integrations (Defender/Sentinel ingest) beyond the manual/
  generic `POST /alerts` ingest endpoint.
- No drag-drop dashboard builder (preset widget library only).
- No destructive migration of existing `source_channel` values.
- No changes to on-call, KB, analytics internals beyond additive reuse.

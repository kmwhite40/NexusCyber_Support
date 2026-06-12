# Nexus MVP-Completion & Enterprise Hardening — Design

**Date:** 2026-06-11
**Status:** Approved for planning
**Scope decision:** MVP-complete · adapter+mock for external systems · security & compliance prioritized first
**Author:** Engineering (with Kevin White)

---

## 1. Context

The Nexus platform (`apps/api` Fastify backend, `apps/web` Next.js frontend) implements a
working vertical slice of the spec in `docs/nexus/`: multi-tenant Postgres RLS, dual-plane
identity (Nexus agents vs customer users), an RBAC+ABAC Policy Decision Point (PDP),
ticketing, an SLA engine, posture findings, service catalog, ConMon, a safe-action
automation engine, hash-chained audit logging, and an in-process event bus.

This effort closes the gaps that block a production **MVP**, prioritizing **security &
compliance**. External integrations (M365 Graph, Teams, SMTP, OIDC/SAML, AI) are built as
**adapter interfaces with mock implementations** — production-swappable, fully testable
here, with no real external calls. Deployment-layer concerns (HA/DR/backups) and gov-cloud
national endpoints are explicitly deferred.

### Established conventions every package MUST follow

- **Migrations:** next number is `0005`; one SQL file per package (or grouped). Tenant
  tables get `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`,
  `ENABLE ROW LEVEL SECURITY`, and the standard isolation policy:
  `USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))`
  with the same `WITH CHECK`. Grant `SELECT, INSERT, UPDATE, DELETE ... TO nexus_app`.
  Global/config tables are org-NULL and read via the **system context**.
- **Modules:** `apps/api/src/modules/<name>.ts`, pure-logic functions exported for unit
  tests; DB work inside `withOrgContext(orgContextFor(actor), async (sql) => …)` or
  `withSystemContext`. Mutations call `audit(actor, {...})` and `publish(event, orgId, {...})`.
- **Routes:** registered in `apps/api/src/http/routes.ts`, Zod-validated, gated with
  `authorize(p, '<permission>', { organizationId })`; deny-by-default. RFC 7807 errors via
  the existing error handler.
- **Permissions:** new verbs added to `PERMISSIONS` and mapped to roles in
  `apps/api/src/db/seed.ts`. `admin.superuser` already implies all.
- **Web:** new pages under `apps/web/app/(app)/<name>/page.tsx`, reusing the vendored
  `components/ui/` library and `lib/api.ts`. **No new external network/image fetches**
  (gov-egress rule, `docs/nexus/10 §V.2`).
- **Adapters:** external touchpoints are a TS interface + a mock implementation selected by
  config; the real implementation is a documented seam, not built this cycle.

---

## 2. Work Packages

Built in three tiers, in order. Each is independently shippable and testable.

### Tier 1 — Security & Compliance

#### WP1 — Compliance & evidence
**Goal:** Map platform activity to compliance controls, surface coverage, and export a
tamper-evident evidence package. Add posture exception lifecycle with separation-of-duties.

- **Migration `0005`:**
  - `compliance_controls` (global config, org-NULL): `framework` (e.g. `NIST-800-53`,
    `NIST-800-171`, `CMMC-L2`), `control_id`, `title`, `family`, `description`. Seeded with
    a starter crosswalk subset.
  - `control_mappings` (global): `control_id` → `evidence_source` enum
    (`audit_action` | `posture_domain` | `conmon_check`) + `source_key`. Defines which
    runtime signals satisfy a control.
  - `posture_exceptions` (tenant, RLS): `finding_id`, `requested_by`, `justification`,
    `compensating_control`, `expires_at`, `status` (`requested|approved|rejected|expired`),
    reuses `approvals` for the SoD decision (approver ≠ requester enforced).
- **Module `compliance.ts`:**
  - `controlCoverage(orgId)` — pure-ish: for each control, inspect mapped evidence
    (recent audit actions present, posture findings in domain, conmon run pass/fail) and
    classify `satisfied | partial | gap`. Unit-tested with injected evidence rows.
  - `evidencePackage(actor, orgId)` — assembles controls + their evidence references +
    a SHA-256 manifest hash over the serialized contents; returns a JSON document.
  - Exception request/approve/reject reusing the `approvals` pattern from `catalog.ts`.
- **Routes:** `GET /compliance/controls`, `GET /compliance/coverage`,
  `POST /compliance/evidence-package`, `POST /posture/findings/:id/exception`,
  `POST /posture/exceptions/:id/decide`.
- **Permissions:** `compliance.read`, `compliance.manage`; `posture.request_exception`
  (exists) for requesting. Auditor/OrgAdmin read; Nexus agents manage.
- **Web:** `/compliance` — control coverage table (satisfied/partial/gap, by framework)
  and an "Export evidence package" action (downloads JSON).

#### WP2 — Audit / SIEM export & integrity verification
**Goal:** Stream audit events to a SIEM and prove the audit chain is intact.

- **Module `audit.ts` additions** (no schema change):
  - `exportSince(cursor, format)` — yields audit rows as NDJSON or CEF. `SiemSink`
    adapter interface (`push(records)`) with a mock `LogSiemSink` (records to
    `notification_deliveries`-style log / returns inline); documented Microsoft Sentinel seam.
  - `verifyChain()` — recomputes `row_hash` over the ordered log and reports the first
    divergence (tamper-evident integrity check). Pure function over rows, unit-tested.
- **Routes:** `GET /audit/export?format=ndjson|cef&since=<id|ts>` (auth: `audit.read`),
  `GET /audit/verify` (auth: `audit.read` + nexus plane). Export action is itself audited.

#### WP3 — JIT elevation & break-glass
**Goal:** Time-boxed privilege elevation with approval, plus an alerting break-glass path.

- **Migration `0005`:** `elevation_grants` (tenant-aware but may be org-NULL for platform
  scope): `user_id`, `granted_permissions text[]`, `reason`, `requested_by`, `approver_id`,
  `break_glass bool`, `status` (`requested|active|expired|revoked`), `expires_at`.
- **Module `elevation.ts`:**
  - `request` → creates `requested` grant + `approvals` row (SoD: approver ≠ requester).
  - `approve` → flips to `active` with `expires_at = now + ttl`.
  - `breakGlass` → immediate `active` grant, **critical** audit event, and an on-call page
    (`publish('oncall.page', …)` / `oncall.createPage`).
  - `activeGrantsFor(userId)` — returns non-expired active grants.
- **Wiring:** `loadPrincipal` (auth/principal.ts) augments `permissions` with active,
  non-expired grant permissions and sets `elevated = true`. Expiry is honored at load time
  (no background revoke needed for correctness; a sweep flips status for reporting).
- **Routes:** `POST /elevation/request`, `POST /elevation/:id/approve`,
  `POST /elevation/break-glass`, `GET /elevation` (active grants, scoped).
- **Permissions:** `elevation.request`, `elevation.approve`. Break-glass restricted to
  defined emergency roles (Tier3/IncidentCommander) and always paged + audited.

#### WP4 — Secure attachments
**Goal:** Upload, scan, and serve ticket attachments without SSRF/malware exposure.

- **Migration `0005`:** `attachments` (tenant, RLS): `ticket_id`, `comment_id` (nullable),
  `filename`, `content_type`, `size_bytes`, `sha256`, `scan_status`
  (`pending|clean|infected|error`), `storage_key`, `uploaded_by`, `created_at`.
- **Adapters:**
  - `BlobStore` interface (`put(key, bytes)`, `get(key)`, `delete(key)`) with a
    `LocalBlobStore` mock (writes under a config'd temp dir, never serves by URL).
  - `MalwareScanner` interface (`scan(bytes) → clean|infected`) with a `MockScanner`
    that flags the EICAR test string; real ClamAV/Defender seam documented.
- **Module `attachments.ts`:** `upload` (size + content-type allowlist, hash, store, scan),
  `download` (org-scoped, streams bytes through the API — no client-visible storage URL,
  SSRF-safe), `listForTicket`.
- **Routes:** `POST /tickets/:id/attachments` (multipart, `@fastify/multipart`),
  `GET /attachments/:id` (scoped stream), `GET /tickets/:id/attachments`.
- **Permissions:** reuse `ticket.comment`/`ticket.update` for upload; read gated by ticket
  visibility (infected attachments are never downloadable).

### Tier 2 — MVP feature completeness

#### WP5 — Knowledge Base
**Goal:** Authored KB with a publish lifecycle, search, and ticket deflection.

- **Migration `0005`:** `kb_articles` (org-NULL allowed for global articles; tenant RLS when
  org-scoped): `title`, `body`, `status` (`draft|review|published|archived`), `version`,
  `tags text[]`, `control_refs text[]`, `author_id`, `published_at`, `tsv tsvector`
  (GIN-indexed, maintained by trigger). `kb_article_versions` (immutable snapshots).
  `kb_deflections` (log: query, suggested_article_ids, deflected bool).
- **Module `kb.ts`:** CRUD; `transition(id, to)` enforcing `draft→review→published→archived`
  with permission gates; `search(q)` over `tsv`; `suggest(text)` for deflection;
  `deflectionMetrics()` (suggested vs deflected rate). Lifecycle/transition validity is
  pure and unit-tested.
- **Routes:** `GET/POST /kb/articles`, `GET/PATCH /kb/articles/:id`,
  `POST /kb/articles/:id/transition`, `GET /kb/search?q=`,
  `POST /kb/deflect` (log), `GET /kb/deflection-metrics`.
- **Permissions:** `kb.read`, `kb.author`, `kb.publish`.
- **Web:** `/kb` — search + browse published articles; author view to create/transition.

#### WP6 — SLA pause/resume + holiday calendars
**Goal:** Honor holidays and on-hold time in SLA math.

- **Migration `0005`:** add `holidays date[]` to `business_calendars` (or a
  `business_calendar_holidays` child table); add `paused_at timestamptz`,
  `accumulated_pause_ms bigint DEFAULT 0` to `sla_instances`.
- **Module `sla.ts`:** `addBusinessMinutes` skips weekend **and** holiday dates;
  `pause(instance)` / `resume(instance)` shift `due_at` by paused duration. On-hold ticket
  transitions pause running SLA instances; resuming the ticket resumes them. Holiday-aware
  math and pause arithmetic are pure and unit-tested.
- **Routes:** `POST /tickets/:id/sla/pause`, `POST /tickets/:id/sla/resume` (agent only),
  plus automatic pause/resume on the relevant ticket status transitions.

#### WP7 — On-call fatigue controls
**Goal:** Reduce alert fatigue without dropping real incidents.

- **Module `oncall.ts`:** page **dedup** (suppress duplicate page for the same
  ticket/severity within a window), **quiet hours** (defer non-Sev1 pages), **Sev1
  override** (always pages immediately). Config via existing `feature_flags` or a small
  policy column. Dedup/quiet-hours decision logic is pure and unit-tested.
- **No new routes** (behavior change inside `createPage`); surfaced in the on-call console.

#### WP8 — Automation gated-action approvals
**Goal:** Let published rules request gated actions safely.

- **Module `automation.ts`:** when a published rule fires a **gated** action
  (`notify_user`, `change_status`, `close_stale`, `reopen`, `add_comment`), record a
  `pending` `automation_execution` + an `approvals` row instead of acting. On approval, the
  action is performed and the execution marked `executed`. Safe actions continue to
  auto-perform as today.
- **Routes:** `GET /automations/pending-approvals`,
  `POST /automations/executions/:id/approve` (auth: `automation.publish`).

#### WP9 — Notification preferences + channel adapters
**Goal:** Per-user channel preferences with quiet hours, behind swappable senders.

- **Migration `0005`:** `notification_preferences` (tenant): `user_id`,
  `channels jsonb` (e.g. `{teams:true,email:true,portal:true}`),
  `quiet_hours jsonb` (`{tz,start,end}`), `severity_floor`.
- **Adapters:** `NotificationChannel` interface (`send(target, message)`); mock
  `TeamsChannel` and `EmailChannel` that record to `notification_deliveries` and log
  "would send". The existing capability-matrix fallback (Teams→Email→Portal) is honored.
- **Module `notifications.ts`:** dispatch respects preferences + quiet hours + capability
  matrix + severity floor. Channel-selection logic is pure and unit-tested.
- **Routes:** `GET /me/notification-preferences`, `PUT /me/notification-preferences`.

### Tier 3 — Reliability & ops

#### WP10 — Testing & CI security gates
- **Integration tests** (`apps/api/test/integration/`): tenant isolation (TC-ISO: a
  customer principal cannot read another org's rows via the API), RBAC/ABAC matrix, and
  happy-path coverage for each new module. They **auto-skip when `DATABASE_URL` is unset**
  (a shared `describe.skipIf` helper) so local unit runs stay DB-free and fast.
- **Unit tests** for every new pure function (control coverage, chain verify, elevation
  expiry, holiday/pause math, KB transitions, dedup/quiet-hours, channel selection).
- **CI (`.github/workflows/ci.yml`):** add a **Postgres service** so integration tests run;
  add **CodeQL** (JS/TS), **CycloneDX SBOM** generation (uploaded as an artifact),
  **Trivy** (or `dependency-review`) scan, and a **license check**. Keep existing
  typecheck → test → build, `npm audit`, gitleaks.

#### WP11 — Observability
- **`/metrics`** endpoint exposing Prometheus-style counters: HTTP requests/errors by
  route class, SLA breaches, pages created/acked, automation executions, audit writes.
  Lightweight in-process counters incremented at the relevant call sites.
- **SLO note** (`docs/nexus/` or README): target availability/latency and what `/metrics`
  + `/healthz` + `/readyz` support.

---

## 3. Cross-cutting requirements

- Every new privileged mutation is **audited** and, where it changes ticket/posture state,
  **publishes an event**.
- Every new route is **deny-by-default** with a seeded permission mapped to appropriate
  roles; customer-plane principals are org-scoped via RLS + PDP.
- Adapters never make real external calls this cycle; selection is config-driven so a real
  implementation drops in without touching call sites.
- Web additions use only vendored UI + `lucide-react`; no new external fetches.
- All new tables follow the RLS/grant conventions in §1; global config is org-NULL and
  read via the system context.

## 4. Error handling & edge cases

- Uploads exceeding the size cap or a disallowed content-type → RFC 7807 `422`/`413`;
  infected scans → stored `infected`, never served, surfaced in the ticket.
- Elevation: expired grants contribute no permissions; break-glass always succeeds for
  authorized emergency roles but is loud (critical audit + page).
- SLA pause/resume is idempotent (double-pause/resume is a no-op).
- Automation gated approvals: re-approving an already-executed execution is a no-op.
- Evidence package and SIEM export are read-only and themselves audited.
- Integration tests that require a DB skip cleanly (not fail) when none is configured.

## 5. Testing strategy

- **Unit (DB-free, existing vitest):** all new pure logic listed in WP10.
- **Integration (DB-backed, skip-if-no-DB):** isolation, RBAC/ABAC, per-module happy paths.
- **CI gate:** typecheck + unit + integration (with Postgres service) + build + security
  scans (npm audit, gitleaks, CodeQL, Trivy/dependency-review, SBOM, license check).
- A change is "done" only when typecheck passes, the relevant tests pass (with evidence),
  and `npm run build` succeeds.

## 6. Out of scope (deferred)

Real M365 Graph / Teams / SMTP / OIDC / SAML / SCIM integration; AI assist; gov-cloud
national endpoints, data-residency, CMK/BYOK, WORM, no-egress validation; CMDB Graph
discovery; mobile app; deployment-layer HA/DR/backup/restore and penetration testing.

## 7. Implementation sequencing

Tier 1 (WP1–4) → Tier 2 (WP5–9) → Tier 3 (WP10–11). WP10 test scaffolding (skip-if-no-DB
helper) lands early so each package ships with tests. A single migration `0005` may be
split per package or grouped; routes/permissions/seed updated incrementally. Each package
is a checkpoint: typecheck + tests + build green before moving on.

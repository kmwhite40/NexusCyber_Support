# Nexus Cyber Platform

Enterprise ITSM / MSP / CSP operations + on-call + **security/compliance posture** platform, multi-tenant and government-cloud-aware (Commercial / GCC / GCC High / Azure Government).

- 📐 **Full product & engineering specification:** [docs/nexus/](docs/nexus/README.md) — Sections A–AE, competitor analysis, ADRs, diagrams.
- 🧱 **Machine-readable artifacts:** [SQL schema](docs/nexus/artifacts/db/schema.sql) · [OpenAPI](docs/nexus/artifacts/api/openapi.yaml) · [Event catalog](docs/nexus/artifacts/events/event-catalog.json)
- 💻 **Reference implementation:** this monorepo (`apps/api`, `apps/web`).

> This codebase implements the **core vertical slice** of the spec end-to-end: multi-tenant isolation with PostgreSQL Row-Level Security, dual identity planes (Nexus agents vs customer users), an RBAC+ABAC policy decision point, ticketing with an SLA engine, the posture database, pervasive audit logging, an in-process event bus, and a Next.js + Tailwind UI using shadcn/21st.dev-style components. It is a working foundation, not the full feature set described in the spec (on-call paging, Graph ingestion, automation engine, etc. are scaffolded/typed but not all wired).

## Architecture (implemented slice)

```
apps/
  api/   Fastify + node-postgres backend
         - config (per-cloud), pg pool, RLS request context
         - auth: dev JWT sessions + token validation seam (prod = OIDC)
         - PDP: RBAC + ABAC authorization, deny-by-default
         - domain: organizations, users, tickets, SLA engine, posture, audit
         - in-process event bus + notifications (M365 Graph mail in prod)
         - request forms: conditional visibility, server-sourced select options
         - PII vault: onboarding personal data held outside tickets.custom_fields,
           permission-gated (pii.view), audited per read, purged on ticket closure
         - onboarding provisioning: pure planner + resumable executor for Entra
           account / licence / group / Temporary Access Pass / Windows 365 Cloud PC
         - CAB: quorum voting, deliberation, board administration, deadline sweeper
         - background jobs: SLA sweeper, mail ingest, retention purge,
           Cloud PC poller, CAB deadline sweeper
         - SQL migrations (mirrors docs/nexus/artifacts/db/schema.sql)
  web/   Next.js (App Router) + Tailwind
         - marketing landing (animated GLSL hero, navbar, pillars, features, CTA)
         - login / signup (self-service account creation) / dev login
         - customer portal dashboard, submit ticket, ticket detail
         - agent queue, posture dashboard, audit log viewer
         - helpdesk analytics (Overview + Agent Analysis) — KPIs, issue
           breakdown, priority/severity donuts, volume trend, agent leaderboards,
           resolution-vs-rating scatter (modeled on an IT Helpdesk Power BI dashboard*)
         - service catalog (workflow-backed request fulfillment) + ConMon panel
         - on-call console (rotation, current responder, pages, ack/escalate)
         - change management: CAB vote panel (tally, quorum, recusal), change
           detail with deliberation + PIR, board / blackout / template settings
         - onboarding provisioning panel (dry-run preview, then Provision)
         - animated 404 page
         - shadcn/21st.dev-style component library (vendored, not CDN)
         - Vitest + Testing Library suite (see Useful scripts)
```

### Vendored 21st.dev / shadcn UI components

All UI components are **copied into the repo** under `apps/web/components/ui/` and governed
as first-party code — **no runtime third-party fetch**, which is a hard requirement for
government enclaves (see [docs/nexus/10 §V.2](docs/nexus/10-stack-ux-ops.md)):

| Component | File | Used in |
|-----------|------|---------|
| GLSL hills (Three.js WebGL hero) | `ui/glsl-hills.tsx` | Landing hero |
| Navbar1 (shadcnblocks) | `ui/navbar1.tsx` + `accordion/navigation-menu/sheet/button` | Landing |
| Display cards (stacked) | `ui/display-cards.tsx` | Landing pillars |
| Liquid / Metal buttons | `ui/liquid-glass-button.tsx` | Landing CTAs |
| Avatar | `ui/avatar.tsx` | App shell user chip |
| Badge (shadcn) | `ui/badge.tsx` | available |
| Animated 404 | `ui/page-not-found.tsx` → `app/not-found.tsx` | 404 route |
| Design system (Button/Card/Badge/Input/Table/charts) | `ui/primitives.tsx`, `ui/data.tsx`, `ui/charts.tsx`, `ui/badges.tsx` | All screens |

Logos/fonts/icons are local or `lucide-react` (bundled) — external image fetches are avoided
so the bundle is reproducible and gov-egress-safe.

Tenant isolation is **belt-and-suspenders**: Postgres RLS keyed on `app.org_id` (set per request) **plus** an application org-guard. See [docs/nexus/02-architecture.md](docs/nexus/02-architecture.md).

## Quick start

Prerequisites: **Node 20+**, **Docker** (for Postgres).

```bash
cp .env.example .env
npm install                 # install workspaces
npm run db:up               # start Postgres in Docker
npm run db:migrate          # create schema (RLS, tables)
npm run db:seed             # seed demo orgs, users, tickets, posture
npm run dev                 # api on :4000, web on :3000
```

Then open http://localhost:3000 — you'll land on the Nexus Cyber marketing site. From there
you can **Create your organization** (self-service signup → you become Org Admin) or sign in
with a seeded demo identity (shown on the login screen):

| Plane | Email | Role | Sees |
|-------|-------|------|------|
| Nexus agent | `agent@nexus.example.com` | Tier 2 Agent | Assigned customer orgs (Acme + Globex) |
| Customer admin | `admin@acme.example.com` | Org Admin | Acme only |
| Customer end user | `user@acme.example.com` | End User | Their own tickets only |

Switching identities demonstrates tenant isolation and RBAC/ABAC scoping live.

## Dev auth note

For local development the API issues signed session JWTs from a seeded user directory (`/auth/dev-login`). In production this is replaced by real OIDC against Nexus Entra ID (agents) and per-customer IdPs (customers) with full issuer/audience/signature validation — the validation seam is in `apps/api/src/auth/`. The dev path is gated to non-production.

## Useful scripts

```bash
npm run typecheck                  # tsc across workspaces
npm --workspace apps/api run test  # vitest (PDP, SLA, posture, on-call, planner, voting, ...)
npm --workspace apps/web run test  # vitest + Testing Library (form visibility, panels)
npm run build                      # build api + web
npm run bootstrap                  # install + db up + migrate + seed (one shot)

scripts/deploy-api.sh              # build in ACR, pin digest, restart, wait for /readyz
scripts/deploy-web.sh              # prebuilt Next standalone bundle -> OneDeploy
scripts/probe-provisioning-tenant.sh   # READ-ONLY tenant probe (SKUs, Cloud PC
                                       # policies, API version, TAP policy)

Integration tests (`apps/api/test/integration/*.int.test.ts`) skip silently unless
`DATABASE_URL` is set. To run migrations or those tests against the dev database:

```bash
cd <repo root>
set -a; . ./.env; set +a          # exports DATABASE_URL (dev DB is on port 5544)
npm --workspace apps/api run migrate
```

Two traps, both of which fail in confusing ways:

- **`npm run migrate -- --env-file ...` does not work.** The `--` forwards the flag to the
  *script*, not to node, so `DATABASE_URL` stays unset and `config.ts` falls back to its
  default of `localhost:5432` — while the dev database is on **5544**. Source `.env` instead.
- **Run workspace scripts from the repo root, or name the workspace.** `npm run` resolves the
  workspace from your current directory, so `npm run migrate` inside `apps/web/...` fails with
  `Missing script: "migrate"` — only `apps/api` has one.
```

## Enterprise hardening

- **Security headers** (`@fastify/helmet`), **rate limiting** (`@fastify/rate-limit`), 1 MiB
  body cap, `trustProxy`, RFC 7807 errors, correlation ids.
- **Health/readiness probes**: `GET /healthz` (liveness), `GET /readyz` (DB-checked readiness).
- **Tenant isolation**: Postgres RLS + app org-guard; global config (tier groups, catalog) is
  resolved via the system context so NULL-org rows aren't blocked by tenant policies.
- **On-call/paging engine**: deterministic weekly rotation, current-responder resolution,
  page → acknowledge → escalate (single-owner reassignment).
- **Observability**: `GET /metrics` (Prometheus text) — HTTP responses by status class,
  5xx errors, and domain events (`sla.breached`, `oncall.page`, `change.*`, …) counted in-process.
- **ITSM service-management parity** (Jira Service Management-class): **ticket linking & merge**
  (duplicate/caused-by/blocks/child-of + incident→problem→change association), **Problem
  management** (root cause, known-error workarounds, recurring-incident clustering), **Change
  management + CAB** (standard/normal/emergency, multi-step Change Advisory Board approval,
  scheduling with window-conflict detection, change calendar), **CSAT** satisfaction surveys
  on resolution, and **saved agent queues** with SLA-aware (soonest-breach-first) sorting.
- **Knowledge base** (Confluence-style): spaces → hierarchical pages with immutable version
  history, draft→review→published lifecycle, Postgres full-text search with highlighted
  snippets, page comments, and ticket-deflection tracking.
- **Compliance & evidence**: NIST 800-53 control catalog with runtime evidence mappings
  (posture / ConMon / audit), per-control coverage (satisfied / partial / gap), hash-stamped
  evidence-package export, and posture exceptions with separation-of-duties approval.
- **Tamper-evident audit + SIEM export**: hash-chained `audit_logs` with a monotonic sequence
  and advisory-lock-serialized appends (the chain cannot fork under concurrency); `GET
  /audit/verify` recomputes the chain, `GET /audit/export` streams NDJSON or CEF to a SIEM sink.
- **JIT elevation & break-glass**: time-boxed privilege grants with separation-of-duties
  approval, effective only while active; break-glass grants are immediate but loud (critical
  audit event + on-call page).
- **Secure attachments**: content-type/size allow-listing, content hashing, malware-scan seam
  (EICAR-aware mock), and org-scoped streaming downloads — infected files are stored but never
  served.
- **Adapter seams** (gov-egress-safe): SIEM sink, blob store, and malware scanner are swappable
  interfaces with mock implementations; no third-party runtime fetch.
- **Tests**: 137 unit + DB-backed integration tests (PDP, SLA math, priority matrix, posture
  scoring, on-call rotation, compliance coverage, audit-chain integrity, elevation SoD,
  attachments, KB lifecycle, ticket links/merge, change/CAB, problem clustering, CSAT,
  queues, metrics); integration suites auto-skip when no `DATABASE_URL` is configured.
- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)): typecheck → migrate/seed →
  test (with a Postgres service) → build, plus `npm audit` (high+), secret scan, **CodeQL**
  SAST, **CycloneDX SBOM**, and dependency review.

## Microsoft 365 (GCC) notifications

The API integrates with M365 (GCC by default) for email notifications and inbound
mail-to-ticket. With no credentials, a **console dev transport** logs messages instead
of sending — the full pipeline still runs. To go live, set the `M365_*` vars in `.env`
(see `.env.example`): an app registration with the **Mail.Send** (and, for ingestion,
**Mail.Read**) application permissions, admin-consented, plus the service mailbox UPN.
Verify with `GET /api/v1/integrations/m365/health` and `POST /api/v1/integrations/m365/test`
(`{"sendTo":"you@agency.gov"}`). GCC uses the commercial Graph endpoints; GCC High/DoD
use the `.us` endpoints (already seeded in `cloud_environments`).

## Onboarding provisioning (feature-flagged, currently OFF)

Turns the SBS "New User Computer/Network Access Form" into a catalog request that, after
approval, provisions the account end to end: Entra user, licence baseline, security groups,
a Temporary Access Pass delivered to the supervisor, and a Windows 365 Cloud PC.

Two properties shape the design:

- **The preview is the plan.** `planRun` is pure, and `provision` executes the *same* plan the
  admin approved in the dry run — bound by a fingerprint, so a change to the ticket between
  preview and execute is refused rather than silently provisioned.
- **Cloud PC provisioning is declarative.** There is no "create a Cloud PC" API. A Cloud PC
  appears when the user holds a Windows 365 licence *and* belongs to a group targeted by a
  provisioning policy. **The licence must be assigned before the group membership**, or the
  Cloud PC silently never builds. The engine never defines VM specs; the existing policy stays
  the source of truth.

Everything stays dark until `M365_PROV_ENABLED=true`, and `enabled` additionally requires the
tenant id, client id, secret, UPN domain and a non-empty licence baseline — a half-configured
app fails closed rather than partway through creating a federal identity.

Before switching it on, see the spec's open items and
[docs/nexus/artifacts/deploy/anchor-provisioning-app-registration.md](docs/nexus/artifacts/deploy/anchor-provisioning-app-registration.md).
`scripts/probe-provisioning-tenant.sh` answers most of them in one read-only run.

## CMDB device sync from customer tenants (feature-flagged, currently OFF)

Populates `configuration_items` device CIs from each customer's own Entra/Intune tenant, so the
CMDB reflects the fleet rather than whatever someone last typed in. Configured per customer at
`/integrations` (`integration.credentials.manage`), then synced on a 6-hour schedule or on demand.

Each customer supplies their own app registration with `DeviceManagementManagedDevices.Read.All`
admin-consented. Nexus never uses one shared credential across tenants — the isolation comes from
the credentials, not from trusting the code to filter correctly.

**The client secret is envelope-encrypted at the application layer** (AES-256-GCM, fresh IV per
seal), because Key Vault is blocked by NIST policy in this enclave. The database holds only
ciphertext, IV and tag; there is deliberately no `client_secret` text column, and nothing stored
is decryptable from the database alone. `INTEGRATION_ENC_KEY` is that key:

> **Losing `INTEGRATION_ENC_KEY` makes every stored customer secret unrecoverable.** Rotating it
> without re-wrapping has the same effect. `key_version` exists on each row so a rotation can
> re-wrap rather than guess.

Design decisions worth knowing before changing this code:

- **Retirement only runs after a complete enumeration.** `planRetirements` cannot distinguish
  "this device is gone" from "we never saw this device", so anything that throws during
  enumeration or upsert propagates and no retirement happens at all. That ordering *is* the
  safety property, and a test pins it.
- **Two guards on top of that**, because a degraded enumeration does not throw — it just returns
  less. Retirement is skipped if the tenant returns zero devices while active synced CIs exist, or
  if a single pass would retire more than half an org's active devices (above a floor of 10, below
  which proportion means nothing). Both report a reason the UI shows verbatim; a skip that does
  not say what to check is not actionable.
- **Personal (BYOD) devices are excluded.** An employee's own phone is not the organisation's
  asset, and recording it would put personal hardware in the CMDB with its owner's UPN attached.
  The test is allow-by-default — only an explicit `personal` ownerType excludes, because Intune
  reports `unknown` for records it cannot classify and treating missing data as personal would
  quietly shrink the CMDB. Excluded devices are also left out of the seen-set, so a personal CI
  created before this rule existed retires on the next sync rather than lingering as a row
  nothing will ever touch again.
- **CIs are retired, never deleted.** A device that left the tenant is still part of what was once
  true. Hand-created CIs stay `source='manual'` and are never touched by a sync.
- **One sync per organization at a time**, via a leased row rather than an advisory lock: the
  window that must be exclusive is enumerate-through-retire — minutes of HTTP — and a lock would
  mean holding a pooled connection for all of it. The lease expires, so a crashed process cannot
  wedge an org forever.
- **`integration.credentials.manage` is not `integration.manage`.** The latter covers M2M API keys
  and outbound webhooks and is held by customer-plane OrgAdmins; configuring the credentials Nexus
  uses to read a customer's own directory is a platform action.

Everything stays dark until `ENTRA_SYNC_ENABLED=true` **and** `INTEGRATION_ENC_KEY` is set — a
half-configured deploy would otherwise fail on every customer with an error that looks like a bad
credential rather than a missing key. Enabling the flag with no configured customers is a no-op:
the sweep iterates only enabled `org_integrations` rows.

## Change management + CAB voting

Quorum-based Change Advisory Board approval: a board with configurable quorum, threshold and
per-member weights; deliberation comments; blackout windows; change templates; a post-implementation
review gate; notifications; and a deadline sweeper.

Design decisions worth knowing before changing this code:

- **Only `resolveVote` decides.** It is pure, and it is the sole writer of an approved or rejected
  status. Quorum and threshold are **snapshotted onto the change at submit**, so editing the board
  mid-vote cannot move the goalposts.
- **The raiser cannot approve their own change.** They are recused from their own board before the
  quorum snapshot, pre-approval ("standard") is bound to a template authored under `cab.manage`
  rather than self-declared, and a role that can raise a change does not administer the board.
- **The deadline sweeper notifies; it never decides.** A timer does not get to approve or reject a
  production change.
- **Blackout windows are advisory** — surfaced when scheduling, never enforced.

> **Deploying this changes live permissions and data.** Migrations `0061`/`0062` revoke
> `change.create` from `ServiceDeskManager` and reclassify existing templates, on the next API boot,
> with no feature flag. Read
> [docs/nexus/artifacts/deploy/cab-permission-changes-runbook.md](docs/nexus/artifacts/deploy/cab-permission-changes-runbook.md)
> first — it covers the announcement sequence and is honest that forward-only migrations mean
> recovery is a compensating migration, not a revert.

## Mapping to the spec

| Spec section | Implemented in |
|--------------|----------------|
| D Multi-tenant + RLS | `apps/api/src/db`, migrations, `withOrgContext` |
| E Identity (planes, PDP) | `apps/api/src/auth`, `apps/api/src/authz` |
| F/G Ticketing + intake | `apps/api/src/modules/tickets` |
| H SLA engine | `apps/api/src/modules/sla` |
| I Posture DB | `apps/api/src/modules/posture` |
| K Notifications | `apps/api/src/modules/notifications` (stub adapter + fallback) |
| Q Audit logging | `apps/api/src/modules/audit` |
| U Event bus | `apps/api/src/events` |
| O Reporting/analytics | `apps/api/src/modules/analytics`, `apps/web/app/(app)/analytics` |
| Request fulfillment + ConMon | `apps/api/src/modules/catalog`, `conmon`; [workflows doc](docs/nexus/workflows/service-desk-workflows.md); `apps/web/app/(app)/catalog` |
| W UX screens | `apps/web/app/*` |

### Lite Helpdesk operating model

Tiered support with a **single accountable owner** per ticket — escalation
**reassigns** ownership (never CC). Tiers: Tier 1 Helpdesk Analyst → Tier 2 M365
Administrator → Security Operations → Engagement Manager → Customer ISSM/AO. The
in-scope activities (user provisioning, deprovisioning/offboarding, password
resets/unlocks, group changes, license assignment, remote support) and **Continuous
Monitoring (ConMon)** are implemented as a **service catalog** with per-request
fulfillment task-checklists, approval gates, tier routing, and SLAs — see the
[workflows runbook](docs/nexus/workflows/service-desk-workflows.md).

\* The helpdesk analytics view's metrics and layout are modeled on the
[IT-Helpdesk-Dashboard](https://github.com/brenden-DS/IT-Helpdesk-Dashboard) Power BI
analysis (KPIs, ≤3-day SLA definition, issue breakdown, agent leaderboards,
resolution-vs-rating scatter), re-implemented natively over our own ticket data.

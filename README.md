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
         - in-process event bus + notification stub
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
         - animated 404 page
         - shadcn/21st.dev-style component library (vendored, not CDN)
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
npm --workspace apps/api run test  # vitest unit tests (PDP, SLA, priority, posture, on-call)
npm run build                      # build api + web
npm run bootstrap                  # install + db up + migrate + seed (one shot)
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

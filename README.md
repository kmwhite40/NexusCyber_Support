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
npm run typecheck     # tsc across workspaces
npm run build         # build api + web
npm run bootstrap     # install + db up + migrate + seed (one shot)
```

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
| W UX screens | `apps/web/app/*` |

\* The helpdesk analytics view's metrics and layout are modeled on the
[IT-Helpdesk-Dashboard](https://github.com/brenden-DS/IT-Helpdesk-Dashboard) Power BI
analysis (KPIs, ≤3-day SLA definition, issue breakdown, agent leaderboards,
resolution-vs-rating scatter), re-implemented natively over our own ticket data.

# Phase 2 Hardening — Design Spec

**Date:** 2026-06-12
**Status:** Approved (design), pending spec review
**Branch:** `feat/nexus-platform` (same-branch; concurrent process is on catalog/forms — collision-free for these files)

## Goal

Close the three gaps found while verifying Phase 2: make `/dashboards` render real data, add the missing create UIs for Channels and Dashboards, and add integration tests for the new modules (alerts, channels, dashboards, services). No new backend endpoints or schema — reuse what exists.

## Item 1 — Dashboard widgets render real data

Today `/dashboards` shows the selected dashboard's `layout` as placeholder label badges. Replace with a `DashboardWidgets` renderer that maps each widget `type` to a live panel using existing endpoints (the same ones `/dashboard` uses):

| Widget `type` | Data source | Render |
|---|---|---|
| `kpis` | `GET /analytics/overview` → `kpis` | StatCards: total tickets, within-SLA %, avg resolution days, avg rating |
| `sla_breaches` | `overview.kpis` (derive `total*(1-withinSlaPct)`, and show within-SLA %) | StatCard |
| `ticket_volume` | `overview.volumeByYear` | simple bar/sparkline list (no new chart lib; reuse the inline bars style already on `/dashboard`) |
| `posture_gauge` | `GET /posture/score` → `{overall_score, grade}` | score + grade |
| `top_findings` | `GET /posture/findings` (top N) | small table |
| `recent_tickets` | `GET /tickets?limit=8` | recent list, rows link to `/tickets/:id` |

- **File:** `apps/web/components/ui/dashboard-widgets.tsx` exporting `DashboardWidget({ type, overview })`. To avoid refetching `/analytics/overview` once per KPI/volume/sla widget, the `/dashboards` page fetches `overview` **once** and passes it as a prop; the `posture_gauge`/`top_findings`/`recent_tickets` widgets fetch their own data internally (with the existing `.catch(()=>...)` + `Skeleton` pattern). Keeps `/dashboards/page.tsx` small.
- Any widget `type` without a clean source renders a labeled empty card (no fabricated data).
- The legacy `/dashboard` remains unchanged (the seeded default still points users there via the existing link).

## Item 2 — Create/edit UIs

- **Channels** (`/channels`): add a "New channel" button opening an inline modal (the established `fixed inset-0 ... bg-black/60` pattern) with fields `type` (email/portal/widget select), `name`, `enabled` (default true) → `channelsApi.create({...})`, then reload. Gated by `can('channel.manage')`.
- **Dashboards** (`/dashboards`): add a "New dashboard" button opening a modal with `name` + a checkbox multi-select over the widget catalog (`kpis`, `ticket_volume`, `posture_gauge`, `top_findings`, `sla_breaches`, `recent_tickets`) → `dashboardsApi.create({ name, layout })`, then reload and select it. Gated by `can('dashboard.manage')`.
- Both need an `organizationId` for nexus-plane actors: reuse the existing org dropdown source (`GET /organizations`, already used by the catalog page) — the modal includes an org picker for nexus users; customer-plane users' org is implicit. (Confirm how `/catalog` sources its org list and mirror it.)

## Item 3 — Integration tests

Add to `apps/api/test/integration/`, following the existing `*.int.test.ts` pattern (`describeDb` skip-guard from `../helpers/db.js`, `withSystemContext`, a `principalByEmail` helper, seeded users like `agent@nexus.example.com` and `manager@nexus.example.com`):

- `services.int.test.ts` — create service + CI as manager; list returns them; `service.read` denial for a customer-plane principal; tenant isolation (org A can't see org B's CIs).
- `channels.int.test.ts` — create/list/update (toggle enabled) as manager; `channel.manage` denial for a read-only role; tenant isolation.
- `dashboards.int.test.ts` — list returns the seeded default; create with mixed valid/invalid widget types persists only valid ones (`sanitizeLayout` end-to-end); cannot delete the default; tenant isolation.
- `alerts.int.test.ts` — create; **dedup** (same `dedupKey` while open returns the same row); **state transitions** (ack→resolve ok; resolved is terminal); **escalation** opens a ticket + page and stores the back-references (this would have caught the `ticket.create` escalation bug); tenant isolation.

These run against the dev DB on 5544 (skipped automatically when no DB, like the others).

## Conventions & non-goals

- Reuse existing primitives (`Card`, `DataTable`, `StatCard`, `Badge`, `Button`, `Select`, `Skeleton`, `EmptyState`) and the inline-modal pattern. No new dependencies, no chart library.
- No new API endpoints or migrations. No change to `/dashboard`, alerts ingest, or RBAC (the escalation fix already landed).
- Verification: `npx tsc --noEmit` (both), `npx vitest run` (unit + the new integration suites against 5544 via `--env-file=../../.env`).

## Phasing

Three independent task-groups; build order: integration tests → dashboard widgets → create UIs (tests first locks correctness; widgets/UIs are additive). Each is its own commit set.

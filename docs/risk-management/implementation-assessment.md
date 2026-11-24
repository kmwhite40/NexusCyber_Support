# Anchor Risk Management: implementation assessment (Phase 0)

Status: draft, 2026-11-24. Scope: the "Anchor — Enterprise Risk Register & Risk Management" specification,
measured against this repository on branch `feat/legacy-import` (stacked on `feat/risk-register`, PR #6).

## 1. Discovered architecture

| Area | What exists | Where |
|---|---|---|
| Product | "Anchor — Control Plane" (repo name Nexus). Web at anchor.azurewebsites.us, API at anchor-api.azurewebsites.us (Azure Government). | `apps/web/app/layout.tsx`, `.github/workflows` |
| Stack | npm-workspaces monorepo. API: Fastify 5, `pg` (no ORM), zod, NodeNext ESM. Web: Next 15, React 18, Tailwind with `hsl(var(--token))` theme tokens. | `apps/api`, `apps/web` |
| Database | PostgreSQL 16, hand-written forward-only SQL migrations (`src/db/migrations/NNNN_*.sql`, 0001 to 0086), applied by `src/db/migrate.ts`. Seed (`seed.ts`) never runs in production. | `apps/api/src/db` |
| Identity | Microsoft Entra ID (OIDC) for the customer and operator planes; local scrypt fallback. Entra user sync is an operator script. | `src/auth`, `src/scripts/sync-entra-users.ts` |
| Authorization | A policy decision point `authorize(actor, permission, {organizationId})` over role→permission grants. Permissions are dual-written: migration plus `seed.ts`. | `src/authz/pdp.ts` |
| Tenant isolation | Three layers: PDP scope check; Postgres RLS (`organization_id = app_org_id() OR app_is_nexus_in_scope(...)`) set per request by `withOrgContext`; module-level same-org checks on every cross-reference. `withSystemContext` bypasses RLS and is reserved for scripts and system lookups. | `src/db/pool.ts`, every migration |
| ITSM entities | tickets (incident, service_request), problems, changes with a CAB (votes, quorum, SoD, blackouts, templates), services, configuration items, posture findings, compliance controls. | `src/modules/*` |
| Audit | Append-only, hash-chained `audit_logs` with a serialized append (advisory lock) and canonical JSON. | `src/modules/audit.ts` |
| Events | In-process bus `publish()` with idempotency keys, fanned out to notifications, webhooks and integrations. | `src/events/bus.ts` |
| Notifications | Templates, recipients and an email dispatcher; M365 mail ingest threads replies by ticket number. | `src/modules/notifications*.ts`, `src/integrations/m365` |
| Jobs | Interval jobs, for example the retention sweeper and SLA timers. | `src/jobs` |
| Attachments | Storage module with per-org scoping. | `src/modules/attachments.ts`, `storage.ts` |
| Tests | Vitest. API: 150 files and 1,401 tests, all passing on 2026-11-12 against a migrated and seeded Postgres 16. Web: Testing Library. | `apps/*/test` |
| CI | Typecheck, test and build; CodeQL; dependency, secret, SAST and SBOM scans; API and web image builds. All green on PR #6. | `.github/workflows` |

## 2. What already exists for risk (PR #6 plus this branch)

Implemented and tested (39 API risk tests, 8 web tests):

- **Per-organization register.** `risks` has per-org numbering (R-0001) and is under RLS. Staff get a cross-organization portfolio; customers see only their own register.
- **Scoring.**
  - 5×5 matrix with inherent, residual and target scores as database-generated columns.
  - Impact dimensions use the FIPS 199 high-water mark.
  - Velocity, plus review cadence derived from the residual rating.
- **Quantitative.** FAIR-style seeded Monte Carlo simulation (PERT distributions, 10k iterations, recorded seed) giving P10, P50, P90 and P95 annual loss. The portfolio reports annual loss as null when nothing is quantified, never as $0.
- **Appetite and tolerance** per organization, plus a maximum acceptance period.
- **Acceptance.**
  - Separation of duties: the requester can never decide.
  - Time-boxed, and capped by the organization's maximum acceptance period.
  - Voided when the risk is re-scored or its FAIR inputs change.
  - `strategy=accept` is allowed only while an acceptance is live.
- **Treatments** with status and due date. Links to controls, findings, tickets, problems, changes and services, validated against the same organization.
- **History and audit.** Append-only `risk_history` snapshots on every change, and every write audited.
- **Exports and import.** CSV export that neutralizes spreadsheet formulas. Import of a risk from a posture finding.
- **Risk report (this branch).** Weekly trend rebuilt from history, a stacked chart of inherent ratings, and today's heat map.
- **Legacy import (this branch).** SBS Federal tickets, changes and risks, idempotent and protected against duplicates.

## 3. Gap against the specification

Classification uses the spec's own scale.

| Spec § | Requirement | Status | Gap |
|---|---|---|---|
| 4 | 16 navigation views | Partially implemented | One page today (register, portfolio, report, detail dialog). Missing: My Risks, Intake, Assessments, Exceptions, KRIs, Appetite admin page, Control Library, Templates, Admin, Audit History as routes. |
| 5 | ~30 entities | Partially implemented | Present: risk, treatment, link, history (snapshot), org settings. Missing: category taxonomy table, methodology and versions, assessment versions, approvals, exceptions, KRIs and measurements, evidence, comments, templates, integration events, optimistic concurrency (`version` column). |
| 6 | Full risk record | Partially implemented | Missing fields: business unit, department, process, vendor, contract, risk manager, reviewer, assumptions, confidence, data sensitivity, closure justification, custom fields. |
| 7 | 21-category hierarchical taxonomy | Partially implemented | 10 fixed categories enforced by a CHECK constraint. Needs a `risk_categories` table (hierarchical, per-org, with an owner) and a migration of the CHECK to a foreign key. |
| 8 | Scoring engine | Partially implemented | **Conflict:** see §4.1. No methodology versioning, configurable matrix, weighted impact or preview endpoint. Residual reductions don't yet require a rationale. |
| 9 | 17-state lifecycle | Not implemented | Six states today. Needs a transition table with justification, evidence and required approvals per edge. |
| 10 | Treatment plans | Partially implemented | Missing: dependencies, milestones, cost actuals, percent complete, verification, remediation-ticket creation from an action, ticket-to-risk activity sync. |
| 11 | Acceptance and exceptions | Partially implemented | Missing: alternatives considered, conditions, compensating controls, routing by category, severity and appetite, renewal and revocation, the PDF memorandum, and a separate exceptions/waivers entity. |
| 12 | Appetite policy | Partially implemented | Org-level only. Missing: per category, service and dimension; versioned policies with effective dates; the "not yet evaluated" state; history scored against the policy in force at the time. |
| 13 | KRIs | Not implemented | |
| 14 | Dashboards | Partially implemented | Have: KPIs, heat maps (inherent, residual, target), rating and category breakdowns, trend, rating mix. Missing: by owner, aging, acceptance trends, rating movement, saved views, date filters. |
| 15 | Register UX | Partially implemented | Client-side filter and sort today. Needs server-side pagination, multi-sort, column chooser, saved views, bulk actions, XLSX import/export, PDF, wizard, duplicate detection. |
| 16 | ITSM integration | Partially implemented | Have: create from a finding, links. Missing: create risk from an incident, problem, change or asset; remediation tickets; related risks shown inside ITSM records; recurring-incident detection. |
| 17 | Control library | Partially implemented | `compliance_controls` exists (shared catalog). Missing: per-org implementation status, effectiveness, testing, evidence, versioned framework mappings. |
| 18 | Quantitative | Partially implemented | Have FAIR Monte Carlo. Missing: SLE×ARO, treatment ROI, scenarios, before/after loss comparison. |
| 19 | Integration contract | Not implemented | Domain events exist, but there's no versioned `risk.*` contract, outbox table or adapters. Carbon, Concord and Fabric must be documented as **not connected** until credentials exist. |
| 20 | AI assistance | Not implemented | An `assist` module exists. Any risk AI feature must stay off by default and keep to the federal data-handling rules in spec §26. |
| 21 | Granular RBAC | Partially implemented | 3 permissions today (`risk.read`, `risk.manage`, `risk.accept`) against the spec's 22. |
| 22 | Evidence | Not implemented | Reuse the attachments store, adding SHA-256, classification and access history. |
| 23 | Notifications | Not implemented (risk) | The platform's notification infrastructure is in place; no risk-specific triggers exist yet. |
| 24 | 18 reports | Partially implemented | CSV export only. |
| 25 | APIs, OpenAPI | Partially implemented | REST routes with strict zod validation. No OpenAPI document for risk. |
| 27 | Benchmarks at 10k, 50k and 100k | Not implemented | Must run in an authorized environment and be reported as measured; no figures will be invented. |
| 29 | 19 documents | Partially implemented | This document is the first. |

## 4. Conflicts and decisions needed

### 4.1 Rating bands (needs a decision before Phase 2)

The current bands (≥20 very high, ≥15 high, ≥8 moderate, ≥4 low, otherwise very low) differ from the spec's default (1–4 Low, 5–9 Moderate, 10–14 High, 15–19 Very High, 20–25 Critical). The spec also requires versioned, configurable methodologies.

Proposal: introduce `risk_scoring_methodologies` with the spec's bands as **version 2** and the current bands frozen as version 1. Every assessment records which version scored it, so past ratings never silently change. New and re-assessed risks use version 2.

This will re-band existing risks the next time each is assessed. For example, 4×4 = 16 is "high" today and becomes "Very High". The 23 imported SBS Federal risks are affected.

### 4.2 Lifecycle migration

Moving from 6 states to 17 changes the meaning of existing rows. Proposed mapping:

| Current | New |
|---|---|
| identified | Submitted |
| assessed | Assessment Review |
| treating | Treatment In Progress |
| monitoring | Monitoring |
| accepted | Accepted |
| closed | Closed |

Acceptance, escalation and treatment progress stay in their own fields, as the spec requires.

### 4.3 Scale

The specification amounts to several engineer-months of work. It is being delivered in the spec's phases, each as its own reviewed pull request. No phase is marked complete without passing tests, and `implementation-status.md` records what is actually verified.

## 5. Constraints carried into every phase

- Forward-only, non-destructive migrations. Each permission is dual-written to the migration and to `seed.ts`.
- Every new table gets RLS with the standard isolation policy. Every cross-reference is checked for same-org.
- No new frameworks or ORMs. Charts stay hand-written SVG; the app has no chart library.
- No commercial-cloud endpoints, telemetry or AI providers without explicit authorization (Azure Government only).
- No push, merge, deploy or production data change without the user's authorization.

## 6. Production data import (SBS Federal)

`apps/api/src/scripts/import-legacy-tickets.ts` imports 59 tickets (closed), 24 change requests (closed) and 23 risks. It is verified locally:

- A dry run previews every row.
- An apply creates them.
- A re-run creates nothing.
- Records entered by hand are matched on content and skipped.
- Every created record is audited.

Running it against production needs migrations 0085 and 0086 deployed, which means PRs merged and deployed. It also needs the SBS Federal organization's ID and authorization to write to production.

# Anchor ↔ ServiceNow Parity & Platform User Administration — Integration Plan

**Date:** 2026-06-25
**Author:** Platform engineering
**Scope:** (1) Gap analysis of Anchor vs ServiceNow ITSM + platform administration; (2) a phased plan to close the gaps, led by **Platform User Administration** (global admin who can scope an admin to a specific org or all orgs).

---

## 1. Executive summary

Anchor is already a production-grade ITSM platform at roughly **80% functional parity with ServiceNow ITSM**, and it *exceeds* vanilla ServiceNow in continuous-monitoring / compliance (ConMon → posture findings → remediation tickets, tamper-evident audit hash-chain). The identity model (two planes, per-org `role_assignments`, RLS isolation, JIT elevation, a `SuperAdmin` bypass) is solid — but there is **no UI to administer platform (nexus) staff or to scope a delegated admin to specific organizations**, which is the capability requested. That is Phase 1.

The remaining ServiceNow gaps (Problem depth, Change calendar, CMDB depth, Flow Designer, Virtual Agent, custom reporting) are real but secondary; they are sequenced in Phases 2–4.

---

## 2. Current-state inventory (grounded in code)

### 2.1 Identity / RBAC / tenancy — what exists
| Capability | Status | Where |
|---|---|---|
| Two-plane users (`nexus` staff vs `customer`) | ✅ | `0001_init.sql:53-67` |
| Roles + 67-permission catalog, role→perm map | ✅ | `0001_init.sql:69-86`, `seed.ts:13-96` |
| **Per-org role assignments** (`role_assignments.organization_id`, UNIQUE(user,role,org)) | ✅ | `0001_init.sql` |
| RLS org isolation + nexus-in-scope + superuser bypass | ✅ | `0001_init.sql:319-343`, `0031_superuser_rls.sql` |
| Principal builds `assignedOrgs` from role assignments | ✅ | `auth/principal.ts:7-54` |
| App-layer PDP (verb + org scope + conditions) | ✅ | `authz/pdp.ts:36-95` |
| JIT elevation / break-glass | ✅ | `modules/elevation.ts` |
| Customer org + customer-user admin UI | ✅ | `web/app/(app)/customers/page.tsx` |

### 2.2 Identity / RBAC — what's missing (the ask)
- **No nexus-staff administration UI** — cannot create/edit/deactivate Tier1/Tier2/SecurityAnalyst/ServiceDeskManager/SuperAdmin users from the web.
- **No per-admin org-scoping UI** — assigning an agent to specific orgs is a manual `role_assignments` INSERT today.
- **No first-class "all orgs" grant short of full `SuperAdmin`** — RLS only grants all-orgs to `admin.superuser` (full god-mode). A delegated admin who should "see all orgs" but with a *limited* role has no clean grant.
- `/me` does not expose `assignedOrgs`, so the client can't show an agent their own scope.

### 2.3 ITSM modules vs ServiceNow
| ServiceNow pillar | Anchor status | Notes / gap |
|---|---|---|
| Incident | ✅ Full | `modules/tickets.ts` |
| Service Request + Catalog (forms/approvals/fulfillment) | ✅ Full | `catalog.ts`, `forms.ts` |
| Problem | ⚠️ Partial | status + incident clustering; **no RCA, no problem→change link, thin workflow** |
| Change (types, CAB, risk, windows, conflict) | ✅ ~90% | `changes.ts`; **no change-calendar view** |
| CMDB / CIs | ⚠️ Thin | `services.ts` registry + relationships; **no discovery, no attribute extensibility, no CI type hierarchy** |
| Knowledge | ✅ Full | `kb.ts` |
| SLA/OLA (calendars, escalation) | ✅ Full | `sla.ts` |
| Workflow / Flow Designer | ⚠️ Limited | JSON automation rules (`automation.ts`); **no visual designer, no branching/parallel** |
| Reporting / dashboards | ✅ Good | `analytics.ts`, `dashboards.ts`; **no self-service report builder** |
| On-call / escalation | ✅ Full | `oncall.ts`, `escalation-policies.ts` |
| Notifications | ✅ Full | `notifications*.ts` |
| Approvals | ✅ Good | catalog/change/elevation |
| Virtual Agent / chat | ❌ Missing | portal only; **no chatbot/NLU deflection** |
| Surveys / CSAT | ✅ Full | `csat.ts` |
| Compliance / ConMon / GRC | ✅ **Differentiator** | `compliance.ts`, `conmon.ts`, `posture.ts` |

---

## 3. Target design — Platform User Administration (Phase 1, the ask)

### 3.1 Concept
A **global admin** (`SuperAdmin`) gets a new **Platform Users** settings page to administer nexus staff and, per user, set **organization scope**:
- **Specific organizations** — the admin/agent sees only the chosen orgs.
- **All organizations** — the admin/agent sees every org (current and future) *without* being granted full `SuperAdmin` god-mode.

This maps directly onto the existing model:
- **Specific orgs** = `role_assignments` rows with `organization_id = <org>` (already supported end-to-end).
- **All orgs** = a new sentinel: a `role_assignments` row with `organization_id = NULL` for a *nexus* role, interpreted as "this role applies to every org." Today only `SuperAdmin` (NULL org) is special; we generalize the wildcard to any nexus role via an `app.all_orgs` RLS flag, so a (say) Tier2 can be granted all-orgs visibility while keeping Tier2-limited permissions.

### 3.2 Backend changes
1. **RLS: generalize all-orgs scope** (new migration).
   - `app_is_nexus_in_scope(target_org)` returns true when `current_setting('app.all_orgs','true')`.
   - `pool.ts` sets `app.all_orgs='true'` when the principal has **any nexus role assignment with `organization_id IS NULL`** (not just SuperAdmin).
   - `SuperAdmin` continues to set `app.superuser='true'` (unchanged).
2. **Principal**: add `allOrgs: boolean` (derived from a NULL-org nexus role assignment); `orgContextFor` passes it through. (`auth/principal.ts`)
3. **`/me`**: return `assigned_orgs: string[]` and `all_orgs: boolean` so the UI can display an agent's own scope. (`http/routes.ts:226-237`)
4. **New admin module + routes** `modules/platform-users.ts` (guarded by new permission `admin.users.manage`):
   - `GET /platform/users` — list nexus users with roles + org scope (orgs[] or all).
   - `POST /platform/users` — create a nexus user (email, name, role).
   - `PATCH /platform/users/:id` — status (active/suspended), display name.
   - `PUT /platform/users/:id/roles` — set role(s).
   - `PUT /platform/users/:id/scope` — set org scope: `{ mode: 'all' } | { mode: 'orgs', orgIds: string[] }`. Writes/clears `role_assignments` accordingly (NULL-org row for `all`, per-org rows for `orgs`).
   - All mutations write `audit_logs` (who changed whose scope/role).
5. **Permission catalog**: add `admin.users.manage` (domain `platform_admin`); grant to `SuperAdmin` (and optionally `ServiceDeskManager`). (`seed.ts` + migration)

### 3.3 Frontend changes
1. **Nav**: add `{ href: '/team', label: 'Platform users', icon: <IconUsers/>, anyPerm: ['admin.users.manage'], section: 'Operations' }` to `NEXUS_NAV` (`components/shell.tsx:15`).
2. **New page** `web/app/(app)/team/page.tsx`:
   - Table of nexus users (email, name, roles, **scope** badge = "All orgs" or "N orgs", status).
   - Create-user drawer; role multiselect.
   - **Scope editor**: radio **All organizations** / **Specific organizations**; when specific, a multi-select org picker (reuse `/organizations`). Visible only to `admin.users.manage`.
   - Deactivate/reactivate.
3. **API client** `platformUsersApi` in `lib/api.ts` mirroring the routes; extend `Me` with `assigned_orgs`, `all_orgs`.
4. **Self-scope visibility**: small "You can see: All orgs / X orgs" indicator in the header for nexus users.

### 3.4 Guardrails
- Only `SuperAdmin` may grant **all-orgs** or assign the `SuperAdmin` role (prevent privilege escalation by a delegated admin).
- A delegated admin with `admin.users.manage` but not `SuperAdmin` may manage agents only within **their own** org scope.
- Every scope/role change is audit-logged and shown in `/audit`.
- Tests: RLS unit tests for the new all-orgs flag (a Tier2 with NULL-org row sees all orgs but still can't do SecurityAnalyst-only actions); PDP scope tests; route authz tests.

---

## 4. ServiceNow gap workstreams (Phases 2–4)

### Phase 2 — ITSM depth (highest ITSM value)
- **Change calendar view** — calendar UI over existing `window_start/window_end`; conflict highlighting.
- **Problem management depth** — RCA fields (root cause, workaround, known-error), problem→change and problem→incident linking, problem timeline.
- **CMDB depth** — CI attribute/property extensibility, CI classes/type hierarchy, relationship graph view; optional import (CSV/Graph/Intune) before any "discovery."

### Phase 3 — Platform power features
- **Flow/Workflow designer** — visual builder over the automation rule engine (trigger → conditions → actions), branching + approval steps; persist as the existing JSON rules.
- **Self-service report builder** — pivot existing analytics into a saveable report definition (dimensions/measures/filters) feeding `dashboards`.

### Phase 4 — Experience
- **Virtual Agent / assisted intake** — LLM-backed deflection on the portal (KB-grounded answers, conversational request creation) using the latest Claude model; routes to a ticket when unresolved. Natural fit with the existing KB + catalog.
- **Delegated customer admin parity** — extend the new admin patterns to customer `OrgAdmin` self-service.

---

## 5. Sequencing & rationale
1. **Phase 1 — Platform User Administration** (the explicit ask; small, high-leverage; model already supports it). ~2–3 focused tasks.
2. **Phase 2 — Change calendar + Problem depth + CMDB depth** (closes the most-visible ITSM gaps).
3. **Phase 3 — Flow designer + report builder** (power-user parity).
4. **Phase 4 — Virtual agent** (largest effort; depends on KB maturity).

---

## 6. Phase 1 task breakdown (ready to implement)
1. Migration: `00xx_platform_user_admin.sql` — `admin.users.manage` permission + grant to SuperAdmin; (no schema change required for scope — reuse `role_assignments`).
2. Migration: `00xx_all_orgs_scope.sql` — generalize `app_is_nexus_in_scope` to honor `app.all_orgs`.
3. `pool.ts` / `principal.ts` — set + thread `all_orgs`; `/me` exposes `assigned_orgs` + `all_orgs`.
4. `modules/platform-users.ts` + routes (+ authz + audit).
5. `lib/api.ts` `platformUsersApi`; `Me` fields.
6. `web/app/(app)/team/page.tsx` + nav item.
7. Tests: RLS all-orgs, PDP scope, route authz.
8. Deploy API (migrations on boot) + web.

**Estimated:** Phase 1 ≈ 1 focused implementation pass.

---

## 7. Open decisions for sign-off
- **Page name/route:** `Platform users` at `/team` (vs `/admin/users`). *Recommend `/team`.*
- **Who can delegate:** all-orgs + SuperAdmin assignment restricted to `SuperAdmin` only. *Recommend yes.*
- **Should `ServiceDeskManager` get `admin.users.manage`** (scoped to their orgs)? *Recommend yes, scoped.*

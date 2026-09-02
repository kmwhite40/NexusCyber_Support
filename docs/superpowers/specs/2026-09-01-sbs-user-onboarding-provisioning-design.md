# SBS New-User Onboarding — Automated Entra Provisioning & Cloud PC

**Date:** 2026-09-01
**Status:** Approved design — ready for implementation planning
**Source:** SBS "New User Computer/Network Access Form" (PDF) + request to automate account
creation, licensing, and Windows 365 Cloud PC provisioning against the SBS Federal tenant.

## Problem

SBS onboards new users from a paper/PDF form. An IT administrator then hand-creates the Entra
account, assigns licenses, adds group memberships, and arranges a Windows 365 Cloud PC. The
process is manual, unauditable, and inconsistent — and the form's data never lands anywhere
queryable.

Anchor already has the intake half of this: `0037_onboarding_and_request_forms.sql` seeds a
`user_onboarding` form (15 fields) linked to the `user.provisioning` catalog item, with real
approval steps, fulfillment tasks, and SLA via `catalog.ts`. What is missing is (a) the
SBS-specific fields, and (b) any write path to Microsoft Graph at all. `accounts.provisionUser`
creates a user row in *Anchor's own database*; it never touches the tenant.

This design adds the SBS fields and a resumable provisioning engine that creates the Entra
account, assigns the license baseline, adds group memberships, issues a Temporary Access Pass,
and drives a Windows 365 Cloud PC to completion.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Tenant scope | **SBS Federal tenant only** | Internal IT use. Credentials follow the existing mail-integration env-var pattern; `org_integrations` + envelope encryption stays deferred with the device-sync spec. |
| Automation boundary | **Human-in-the-loop with a dry run** | Approval completes, an admin reviews a preview of exactly what will be created, then clicks Provision. A bad form entry cannot silently create a federal identity. |
| PII handling | **Collect, restrict, auto-purge** | Home address ships hardware; personal email/cell support contact. Stored apart from `custom_fields`, permission-gated, audited on read, purged on ticket closure. |
| First sign-in | **Temporary Access Pass to the supervisor** | Time-boxed and single-use; never sends a credential to an unmanaged consumer mailbox. Requires the TAP policy enabled in the tenant. |
| Engine shape | **Dedicated run/step state machine** | Cloud PC provisioning is asynchronous and multi-step; identity creation must be resumable per step. The fulfillment-task model and the automation-rule engine both lack ordered dependent steps and partial-failure recovery. |

## Tenant facts (confirmed)

- Exactly one Windows 365 provisioning policy: **`SBSFederal Cloud PC`** — Windows 11 Enterprise
  image, License type Enterprise, already assigned to a group.
- Minimum license baseline for every new user: **Microsoft 365 E3 GCC High**, **Defender for
  Endpoint**, and the Windows 365 Cloud PC SKU that the paper form recorded as "Office 365 Plan
  (2)" — see Open Item 1 (RESOLVED) below for the exact `skuPartNumber`/`skuId` and a zero-width-
  character landmine in the tenant's own catalog data that is worth reading before configuring
  `M365_PROV_BASELINE_SKUS` by hand.
- **Hard ordering constraint:** the license must be attached *before* the user is added to the
  provisioning policy's group. Adding an unlicensed user to the group yields a Cloud PC that
  silently never builds.

## Architecture

Cloud PC provisioning is **declarative, not imperative**. There is no "create a Cloud PC" API.
A Cloud PC materialises when a user holds the right Windows 365 license *and* belongs to a group
targeted by a provisioning policy; the service then builds it asynchronously (roughly 30-90
minutes). Anchor therefore never defines VM specs — the existing policy remains the source of
truth. Anchor assigns the license and the group membership, then watches until the Cloud PC
reports provisioned.

Flow:

1. Requester submits the `user_onboarding` catalog form.
2. Existing approval steps run (unchanged).
3. An admin opens the ticket's Provisioning panel and clicks **Preview** — the planner resolves
   tenant state read-only and returns the exact plan.
4. Blocking problems (UPN taken, SKU absent, zero seats, policy group unresolvable, privileged
   collision) disable **Provision**.
5. **Provision** walks the same plan with side effects enabled, recording each step.
6. `await_cloudpc` is advanced by a background poller until provisioned or the deadline elapses.

## Data model

### Migration `0053`, part A — forms subsystem and PII

Extends the forms subsystem generically (not onboarding-specific):

- `form_fields.visible_when jsonb` — e.g. `{"field":"access_type","equals":"Temporary"}`.
  Evaluated in **both** the renderer and `validateAgainstForm`, so a hidden required field
  cannot block submission.
- `form_fields.sensitive boolean not null default false`.
- `form_fields.options_source text` — when set, the renderer populates a `select`'s choices from
  a named server-side provider instead of the static `options` array. First provider:
  `cloudpc_policies`, backed by `GET /api/v1/provisioning/cloud-pc-policies`, which lists the
  tenant's provisioning policies. Without this, "options fetched live from Graph" has no
  mechanism — `options` is a static jsonb array. Falls back to `options` when the provider is
  unreachable, so a Graph outage degrades the field rather than breaking the form.
- Extend the `data_type` CHECK with `email` and `phone` (same approach as `0032`), plus matching
  `FieldType` entries and validation in `forms.ts`.

New table **`ticket_sensitive_fields`**: `ticket_id`, `key`, `value`, `created_at`.
Deliberately *not* `tickets.custom_fields`, because that JSON is returned wholesale on ticket
reads and would leak into notification payloads and the `0051` outbound webhooks.

- RLS plus a new **`pii.view`** permission granted to `SuperAdmin` and `ServiceDeskManager`
  (following the `0042` grant pattern). Without it, agents see `••••`.
- Never serialised into notification templates, webhook payloads, or the ticket list response.
  Reachable only via `GET /tickets/:id/sensitive`, which checks the permission and writes an
  `audit()` entry **per access** — reading a home address is a logged event.
- Purged on ticket closure by a small job, leaving a tombstone audit record.

The provisioning engine reads these in system DB context, so it can use the values without
exposing them to the agent UI.

### Migration `0053`, part B — SBS form fields

Added to the existing `user_onboarding` form:

| Field | Type | Notes |
|---|---|---|
| `legal_last_name`, `legal_first_name`, `middle_name` | text | Replaces the single `new_employee_name` |
| `preferred_first_name` | text | Drives display name when present |
| `access_type` | select | Permanent / Temporary |
| `hire_type` | select | Direct Hire / Temporary / Consultant |
| `employee_id` | text | |
| `request_kind` | select | New Hire / Replacement |
| `replacement_for` | user | `visible_when` request_kind = Replacement |
| `end_date` | date | `visible_when` access_type = Temporary; required when shown |
| `supervisor` | user | PDF "Supervisor's Name"; reuses the `manager` mapping |
| `work_location` | select | WFH-Permanent / WFH-Temporary / On Site |
| `duty_location` | text | |
| `email_account` | select | Create New / Change Existing |
| `cloud_pc_policy` | select | `options_source = cloudpc_policies` — resolved from Graph, not hardcoded |
| `personal_email`, `cell_phone` | email / phone | `sensitive` |
| `home_address_street`, `home_address_csz` | text | `sensitive`, `visible_when` work_location is WFH |

Retained unchanged: `start_date`, `job_title`, `department`, `employment_type`, `location`,
`manager`, `copy_from`, `license_bundle`, `security_groups`, `hardware`, `mfa_method`, `notes`,
`approvers`, `on_behalf_of`.

### Migration `0054` — provisioning runs

**`provisioning_runs`** — one row per attempt: `id`, `ticket_id`, `organization_id`,
`status` (`planned` | `running` | `awaiting_cloudpc` | `succeeded` | `failed`), `plan jsonb`,
`started_by`, `started_at`, `finished_at`, `error`. Retrying creates a **new** run; history is
never overwritten.

**`provisioning_steps`** — `id`, `run_id`, `step_key`, `position`,
`status` (`pending` | `running` | `succeeded` | `failed` | `skipped`), `request jsonb`,
`response jsonb`, `graph_object_id`, `error`, `attempts`, `started_at`, `finished_at`.

## Provisioning engine

### Steps

| # | Step | Depends on | Operation |
|---|---|---|---|
| 1 | `create_user` | — | `POST /users`; captures the object ID |
| 2 | `assign_licenses` | 1 | Baseline SKUs — **must precede 4** |
| 3 | `add_groups` | 1 | Security/distribution groups from the form |
| 4 | `assign_cloudpc` | 2 | Add to the group backing `SBSFederal Cloud PC` |
| 5 | `issue_tap` | 1 | Temporary Access Pass, delivered to the supervisor |
| 6 | `await_cloudpc` | 4 | Async poll, not a request |

### One code path for preview and execution

A pure `planRun(formAnswers, tenantState)` returns the step list. Executing walks that same plan
with side effects switched on. The preview is therefore *the plan*, not a second description of
it that can drift — which is the entire premise of the human-in-the-loop decision. The planner
is unit-testable with no Graph access, matching how `resolveVote` and `planActions` are already
structured.

### Idempotency

Per step, keyed on `graph_object_id`:

- `create_user` first queries for the UPN and **adopts** an existing object rather than erroring,
  so a retry after a network timeout that actually succeeded server-side does not double-create.
- `assign_licenses` diffs current against desired and assigns only the delta.

### Licenses resolved, never hardcoded

A configured list of SKU part numbers is resolved against `/subscribedSkus` at dry-run time.
This yields real display names in the preview and checks
`prepaidUnits.enabled − consumedUnits`, so **"no seats left" surfaces in the preview rather than
failing halfway through provisioning**. A configured SKU absent from the tenant fails the dry run
closed rather than creating a half-licensed user.

### Cloud PC polling

`await_cloudpc` is driven by a poller registered like the mail-ingest background job. Every few
minutes it checks `/deviceManagement/virtualEndpoint/cloudPCs` for runs in `awaiting_cloudpc`.
On `provisioned` it completes the run, posts a ticket worklog, and lets the fulfillment checklist
auto-resolve. A configurable deadline (default 4 hours) marks the run failed so a stuck build
does not hang forever.

## Graph layer

### A separate app registration: `Anchor-Provisioning`

Deliberately **not** the existing `Anchor-Authentication` app that holds Mail.Send/Mail.Read.
That app backs a long-running ingest poller reachable from the mail path; granting it
directory-write would make a compromise there a compromise of the identity plane. Two apps, two
secrets, two blast radii.

Application permissions (admin consent required):

| Scope | For |
|---|---|
| `User.ReadWrite.All` | Create the account |
| `Organization.Read.All` | Read `/subscribedSkus` for SKU resolution and seat counts |
| `Group.ReadWrite.All` | Security/distribution groups and the Cloud PC policy group |
| `UserAuthenticationMethod.ReadWrite.All` | Issue the Temporary Access Pass |
| `CloudPC.ReadWrite.All` | Read provisioning policies, watch Cloud PC state |
| `Policy.Read.All` | **Probe only** — read the authentication-methods policy to confirm the Temporary Access Pass method is enabled (Open Item 4). Not needed by the running provisioning engine; grant it only if you want `scripts/probe-provisioning-tenant.sh` to answer that item automatically, and revoke it afterwards if you prefer a minimal standing grant. |

`UserAuthenticationMethod.ReadWrite.All` is the sharpest — it can reset authentication methods on
any account. Scoping these permissions to an **administrative unit** is recommended so the app
can only touch new-hire OUs; see Open Items.

### Configuration

A `parseProvisioningConfig` beside `parseM365Config` in `config.ts`, reading `M365_PROV_ENABLED`,
`M365_PROV_TENANT_ID`, `M365_PROV_CLIENT_ID`, `M365_PROV_CLIENT_SECRET`, `M365_PROV_UPN_DOMAIN`,
`M365_PROV_BASELINE_SKUS`, `M365_PROV_CLOUDPC_POLICY`.

Secrets live in App Service config injected via managed identity — the same residual trust
boundary the device-sync spec documents, since Key Vault is blocked by NIST policy in the gov
enclave. The feature stays dark until `M365_PROV_ENABLED=true`, so it ships safely before the
tenant side is ready.

`token.ts` needs no changes: it is already parameterised by tenant/client/secret and derives
scope as `${graphEndpoint}/.default`. GCC High endpoints (`graph.microsoft.us`) come from the
existing `cloud_environments` mapping for `gcchigh`.

### Changes to `graph-client.ts`

1. **Add `PATCH`** — `request` is typed `'GET' | 'POST'`. Updating user attributes needs PATCH.
   The existing 429/503 backoff applies unchanged.
2. **Make the API version selectable** — the URL hardcodes `/v1.0`. Parts of the Windows 365
   surface under `/deviceManagement/virtualEndpoint` have historically lived in `/beta`; an
   `apiVersion` option avoids discovering mid-implementation that the client cannot reach the
   endpoint.

### Safety guards (in the provisioning module, not the Graph client)

- **UPN domain allow-list** — refuse any UPN outside the configured domain, so a malformed answer
  cannot create an identity in an unexpected namespace.
- **Privileged-account refusal** — before adopting an existing user on retry, check for directory
  roles and abort if any are held. A retry can never attach licenses or reset auth methods on an
  admin account that collides on UPN.

Both are pure and unit-testable without Graph.

## UI

### Targeted refactor

The dynamic-form renderer is an inline `data_type` switch in `catalog/page.tsx` (~lines 164-180).
The form grows from 15 to ~28 fields and gains conditional visibility, so that switch is extracted
into a `DynamicFormField` component — the home for `visible_when`, `email`/`phone`, and
sensitive-field masking. This is necessary to the work, not unrelated cleanup.

### Provisioning panel

On the ticket detail page, gated behind the provisioning permission and rendered only once
approvals have passed:

1. **Preview** runs the planner read-only: the exact UPN, each license by real display name with
   remaining seat count, the groups, whether a Cloud PC will be requested, and the TAP destination.
2. Blocking problems render as refusals, not warnings. **Provision stays disabled while any exist.**
3. **Provision** executes, streaming per-step status.
4. Failures show the step, the Graph error, and **Retry** — a new run whose completed steps adopt
   existing objects rather than redoing them.

## Failure handling

**Partial completion is a normal state, not an error.** A user created and licensed with a Cloud
PC still building is `awaiting_cloudpc` — a legitimate resting place that can persist for 90
minutes. Only a genuine step failure, or the Cloud PC deadline elapsing, marks a run `failed`.

Every terminal transition writes a ticket worklog, so the ticket reads as a complete narrative
without anyone opening the runs table.

Graph 429/503 is absorbed by the existing backoff. Client-secret expiry surfaces through the same
health-check path the mail integration uses, so it fails visibly rather than as a confusing
provisioning error months later.

## Testing

Follows the codebase's existing pure-function-first pattern (`resolveVote`, `planActions`), and
`graph-client` already accepts injectable `fetchImpl` and `sleep`.

- **`planRun`** — pure over form answers plus a tenant-state snapshot: license resolution, seat
  exhaustion, ordering (licenses before the Cloud PC group), conditional-field effects. No Graph,
  no DB.
- **`validateAgainstForm`** — `visible_when` cases, specifically that a hidden required field does
  not block submission and a shown one does.
- **Executor against a fake Graph** — step adoption on retry, license delta computation, UPN
  allow-list rejection, privileged-account refusal.
- **Poller** — state transitions with an injected clock, including deadline expiry.
- **PII** — masked without `pii.view`, audited when revealed, purged on closure.

## Open items to confirm against the tenant

Each of these was a question for the SBS tenant admin, with a defined fallback so implementation
was never blocked. Item 1 was resolved by probing `/subscribedSkus` on the live tenant on
2026-09-01 with a delegated directory-read identity. Items 2 and 4 remain open — probed the same
day, but the identity used had directory read only, not the Intune/Cloud PC or policy read the
probes need. Item 3 is therefore also still open, as a consequence of item 4's probe never
getting past authorization.

1. **The third baseline SKU — RESOLVED.** "Office 365 Plan (2)" on the paper form turned out to
   mean the Windows 365 Cloud PC plan at the **2 vCPU** configuration — "(2)" denoted the core
   count, not a second Office plan. The concern that a Windows 365 licence might be missing from
   the tenant entirely was unfounded, but only because of that reading; nothing about the SKU's
   own name says "Windows 365" or "Cloud PC." The three confirmed baseline SKUs, by exact
   `skuPartNumber`:

   | Licence | `skuPartNumber` |
   |---|---|
   | Microsoft 365 E3 GCC High | `SPE_E3_USGOV_GCCHIGH` |
   | Defender for Endpoint | `MDATP_GCC_High_USGOV_GCCHIGH` |
   | Windows 365 Cloud PC, 2 vCPU/4GB/64GB | `CPC_E_2C_4GB_64GB_USGOV_GCCHIGH` (as typed) |

   **The Cloud PC `skuPartNumber` is not safe to copy-paste.** The tenant's own
   `/subscribedSkus` response carries a **ZERO WIDTH SPACE (U+200B)** at index 17, between
   `64GB` and `_USGOV` — invisible in a browser, a terminal, or most editors, and not something
   any operator can type. The string an operator writes into `M365_PROV_BASELINE_SKUS`
   (`CPC_E_2C_4GB_64GB_USGOV_GCCHIGH`) is therefore never byte-equal to what the tenant returns.
   Before this was diagnosed, an exact-string match in the planner turned that into a
   `sku_missing` blocker for a SKU that visibly *is* present — fails closed, but for the wrong
   reason, and sends whoever is debugging it hunting in the wrong place. `planRun` (and the
   Cloud PC policy `displayName` lookup, and group-name resolution) now match through
   `normalizeForMatch` (`apps/api/src/modules/provisioning/planner.ts`), which strips zero-width
   characters (U+200B/U+200C/U+200D/U+FEFF) and case-folds before comparing — see that file for
   the fix. **The unambiguous identifier for this SKU is its `skuId`:
   `6bd7db5d-58d9-4ab9-b240-114e5f0d2e00`** — use it (not the part-number string) whenever an
   invisible-character mismatch is a live concern, e.g. cross-checking the Entra admin center by
   eye.

   **Seat position, confirmed the same probe (constrains rollout):**

   | SKU | Enabled | Consumed | Free |
   |---|---:|---:|---:|
   | Windows 365 Cloud PC (2 vCPU) | 10 | 8 | **2** |
   | Microsoft 365 E3 GCC High | — | — | 3 |
   | Defender for Endpoint | — | — | 3 |

   The Cloud PC seat count is the binding constraint: **at most two more users can be fully
   provisioned** (identity + all three licences + Cloud PC) before more Windows 365 seats are
   purchased. The planner's `no_seats` blocker (`planRun`, per-SKU `enabled - consumed <= 0`
   check) surfaces this correctly in the dry-run preview when it is hit — no code change needed
   to make that constraint visible to an admin running a preview.

2. **Administrative-unit scoping** of the `Anchor-Provisioning` permissions — still OPEN. Depends
   on how SBS's AUs are laid out. Fallback unchanged: tenant-wide application permissions, with
   the UPN allow-list and privileged-account refusal as compensating controls. Attempted
   2026-09-01 against `/deviceManagement/virtualEndpoint/provisioningPolicies` (the closest read
   available to probe Intune/Cloud PC scoping) with a delegated directory-read identity; the
   request was rejected `accessDenied` on both `v1.0` and `beta` before reaching any
   AU-scoping-specific response. Answering this needs either the `Anchor-Provisioning` app
   registration with its consented scopes, or a session holding Intune/Cloud PC read.
3. **v1.0 vs beta** for the `/deviceManagement/virtualEndpoint` operations **in GCC High
   specifically** — still OPEN, and unresolved as a direct consequence of item 2/4's probes: both
   attempts (2026-09-01) were rejected on authorization (`accessDenied`) before the response ever
   got far enough to reveal a version-specific difference, so this probe never really ran. The
   `apiVersion` option on the Graph client still exists precisely so the answer is a
   configuration detail once a credential with the right scope is available to probe it.
4. **TAP policy enabled** in the tenant — still OPEN. Attempted 2026-09-01 against
   `/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/temporaryAccessPass`
   with a delegated directory-read identity; rejected `accessDenied` — that identity has
   directory read but not the policy-read permission this endpoint needs. Fallback unchanged: if
   TAP turns out not to be enabled, the `issue_tap` step is marked `skipped` and the admin sets
   the first credential out-of-band; the rest of the run is unaffected. Needs the
   `Anchor-Provisioning` app registration (or an equivalently-scoped session) to resolve.

## Out of scope

- Multi-tenant / per-customer provisioning (`org_integrations`, envelope encryption) — deferred
  with the CMDB device-sync spec.
- Offboarding / deprovisioning.
- The "Change Existing" email-account path — the form captures it, but this build provisions new
  accounts only; existing-account changes remain a manual fulfillment task.
- Hardware procurement and shipping workflow beyond capturing the address.

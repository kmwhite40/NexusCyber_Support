# Offboarding phase 2 — retention holds (design)

Status: approved in brainstorming 2026-09-02, not yet planned or built.

Implements the SBS IT Runbook's retention rule: **departed accounts are retained for 1 year, and
privileged accounts for 7 years.** Phase 1
(`docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md`) disables, renames, delicenses and
degroups; it deletes nothing and enforces nothing about how long the account survives afterwards.

## What this can and cannot be

Nexus **never deletes Entra accounts** — no code path in the product does — and it cannot stop an
administrator deleting one directly in the Azure portal. So a retention hold cannot be a lock.

What it can be is **the thing that notices.** Nexus records the obligation at offboarding, then
periodically checks whether each retained account still exists. An account that disappears before
its date raises a compliance breach; one that reaches its date raises a disposal ticket. That is
what an auditor actually asks for — evidence the rule was followed, and detection when it was
not — and it is honestly achievable from here.

The alternative worth knowing about, and deliberately NOT chosen: enforcing in the tenant itself
(restricted delete permissions, PIM, a tenant retention policy) would be a stronger guarantee.
It is tenant configuration, not product work, and does not conflict with this design. If it is
ever done, this feature becomes the audit trail for it rather than the only control.

## A seven-year obligation must not depend on a foreign key

The single most important structural decision here.

A hold outlives the offboarding ticket, the provisioning run, and possibly the account itself. If
it were a view over `provisioning_runs`, or carried a cascading FK to `tickets`, then tidying a
ticket would silently destroy the record of an obligation that still had six years to run — and
the absence would look exactly like compliance.

So the hold **denormalizes the account's identity** (`upn`, `entra_object_id`,
`display_name_at_offboard`) and every FK is `ON DELETE SET NULL`. A hold must be able to say
which account it is about without joining to anything.

## Data model

`retention_holds`, one row per retained account, created when an offboarding run reaches
`succeeded`.

| Column | Purpose |
|---|---|
| `id` | PK |
| `organization_id` | RLS scope, supplied explicitly on every write |
| `upn`, `entra_object_id`, `display_name_at_offboard` | Denormalized identity — see above |
| `retention_class` | `'standard'` \| `'privileged'` |
| `classification_basis` | jsonb: WHY it is privileged — which directory roles, which Nexus roles, which elevation grants. An auditor asking "why seven years?" gets the answer from the row. |
| `offboarded_at` | When the run completed |
| `retain_until` | `offboarded_at` + 1 year or 7 years |
| `state` | `'active'` \| `'breached'` \| `'eligible'` \| `'disposed'` |
| `last_checked_at` | Nullable. So a sweeper that has stopped running is detectable. |
| `run_id`, `ticket_id` | Provenance, both `ON DELETE SET NULL` |
| `created_at`, `updated_at` | |

Indexes: `(state, retain_until)` for the sweep, and a unique `(entra_object_id)` among non-disposed
holds so one account cannot accumulate duplicate obligations.

`retain_until` is computed from run completion, not from the last day: the account's disabled life
begins when the teardown actually ran.

## Classification — any evidence of privilege, ever

Three independent sources, OR'd. Over-retention is the correct direction to err: keeping a record
too long costs storage, keeping it too short is a compliance failure that cannot be undone after
the fact.

1. **Entra directory roles at offboarding** — `directoryRoleCount > 0`, which the phase-1 planner
   already computes and already surfaces in the preview.
2. **A privileged Nexus role** held by the departing user: `admin.superuser`, `cab.manage`,
   `provisioning.execute`, `admin.users.manage`.
3. **Any row in `elevation_grants` for that user — including expired, revoked, and break-glass.**

Point 3 is the one that is easy to get wrong. The grant's CURRENT status is irrelevant: if the
person ever held elevation, the privilege existed and seven years is the honest answer. Filtering
to active grants would quietly downgrade exactly the people the rule exists to cover, and it would
do so invisibly, because by definition their access has already been removed.

`classification_basis` records which of the three fired and with what evidence.

## The sweeper

Daily. A one-to-seven-year window needs no finer resolution, and each check is one Graph read per
active hold.

For each `active` hold:

| Situation | Action |
|---|---|
| Account present, `retain_until` in the future | Update `last_checked_at`. Nothing else. |
| **Account gone before `retain_until`** | State → `breached`. Raise a ticket naming the account, its class, its retain-until, who offboarded it, and when it was last seen intact. This is the compliance breach the feature exists to notice. |
| `retain_until` reached, account present | State → `eligible`. Raise a disposal ticket for the desk. |
| Account gone after `retain_until` | State → `disposed`. No alarm — someone did the right thing outside Nexus, and recording it is enough. |

**Nothing is ever deleted automatically.** A cron job destroying seven-year federal records
unattended is not supervisable, and the failure would be discovered years later by an auditor
rather than by the system.

### Two failure modes handled explicitly

Both exist because the dangerous outcome here is a check that *looks* like it passed:

- **A Graph error leaves the hold `active` and does NOT update `last_checked_at`.** A tenant
  outage must never be recorded as "account confirmed present" — that is the one reading that
  would let a real breach pass unnoticed.
- **The job reports how many holds it could not check**, so a silently failing sweeper is
  visible. A retention system nobody notices has stopped is worse than none, because it is
  trusted.

## Notifications

Breach and disposal both surface as tickets rather than notifications, reusing the existing
ticket, SLA and audit machinery. A notification is a thing to miss; a ticket is a thing to work.

## Testing

- **Classification (pure):** each of the three sources independently produces `privileged`;
  an expired/revoked elevation grant still does; none of them produces `standard`;
  `classification_basis` records which fired.
- **Date computation (pure):** 1 year vs 7 years from run completion; leap years.
- **Sweeper (mocked Graph + DB):** each of the four situations produces the right state
  transition; a Graph error leaves the hold active AND leaves `last_checked_at` untouched;
  the unchecked count is reported; a breach raises exactly one ticket, and a second sweep does
  not raise a duplicate.
- **Integration:** the hold survives deletion of its ticket (FK is SET NULL, identity intact).

## Out of scope

- **Automatic deletion at expiry.** Deliberate; see above.
- **Backfill.** No existing production ticket has been through an offboarding run, so there is
  nothing to backfill. If holds are ever needed for historical departures they should be created
  deliberately, with their basis recorded, not inferred.
- **Tenant-side enforcement.** Complementary, not part of this.

## Open question

- Where should the breach and disposal tickets be raised — which organization, catalog item and
  assignment group? The offboarding tenant org is the obvious owner, but the catalog item does
  not exist yet and may want to be a new one (`security.retention_review`) rather than reusing an
  existing request type.

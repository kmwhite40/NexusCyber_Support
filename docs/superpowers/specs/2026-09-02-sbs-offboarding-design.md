# SBS Federal offboarding — design (phase 1)

Status: approved in brainstorming 2026-09-02, not yet planned or built.

Source of truth for the process itself is the SBS IT Runbook offboarding section. This spec
covers **phase 1 only**: the M365 execution engine and the scheduled disable. Phases 2–4
(retention holds, CMDB asset returns, partner/HR notifications) are scoped at the end and get
their own specs.

## Why this exists

Offboarding today is a seven-step checklist on the `user.offboarding` catalog item where three
steps are flagged `automatable` and none of them are actually automated — a tech reads the
runbook and clicks "Complete" when they believe they have done the thing. Nothing verifies the
account was disabled, nothing records which licenses came back, and the runbook's ordering
constraints live only in the head of whoever is working the ticket.

The onboarding provisioning engine already solved the hard half of this problem — planning,
human approval bound to a fingerprint, per-step execution with recorded evidence. Offboarding
should inherit that discipline.

## The decision that shapes everything: imitate, don't share

Offboarding gets its own engine — `modules/offboarding/{planner,executor,index}.ts` — mirroring
the provisioning module's shape rather than extending it.

`modules/provisioning/index.ts` opens by declaring that exactly one planning path exists, so
the plan an admin approves is provably the plan that runs. That invariant is what makes the
approval meaningful. Threading a second flow through the same planner would weaken it for the
sake of avoiding some duplicated scaffolding — a poor trade when the second flow is the
destructive one. **Onboarding creates; offboarding destroys.** A bug in offboarding must not be
able to reach the onboarding path.

What IS shared: the `provisioning_runs` / `provisioning_steps` tables, via a `kind` discriminator
(`'onboarding' | 'offboarding'`). Run history, in-flight guards, and step evidence are the same
problem in both directions and should not be solved twice.

## Step set and ordering

| # | Step key | Action | Ordering constraint |
|---|---|---|---|
| 1 | `block_signin` | `accountEnabled=false` | — |
| 2 | `revoke_sessions` | revoke refresh tokens | after 1 — a live session otherwise mints new tokens against a still-enabled account |
| 3 | `rename_account` | `displayName` → `<inactive_name>` | — |
| 4 | `convert_shared_mailbox` | convert to shared, standard/elevated only — **prompted manual step, see below** | **before 5** |
| 5 | `remove_licenses` | reclaim all assigned SKUs | after 4 |
| 6 | `remove_groups_dls_roles` | groups, distribution lists, directory roles | after 5 |

**The constraint the planner exists to protect:** a mailbox can only be converted to shared
while it is still licensed. Remove the license first and the mailbox enters soft-delete and the
conversion fails — destroying the artifact the runbook was trying to preserve. The planner emits
these steps in this order or it emits nothing; the executor refuses a plan whose steps arrive in
any other order, the same way the provisioning executor refuses group names with no resolved ids.

### Step 4 is not automatable in phase 1

Microsoft Graph exposes no mailbox-type conversion endpoint; `Set-Mailbox -Type Shared` is an
Exchange Online PowerShell operation, in GCC High as in commercial. Building an EXO PowerShell
execution path is a substantially larger piece of work than this phase, and pulling it in would
delay every other step.

So step 4 is a **prompted manual step with evidence capture**: the executor pauses, the tech
performs the conversion in EXO and confirms, and the confirmation (who, when) is recorded on the
step like any automated one. **The ordering protection is unaffected** — the planner still
refuses to emit `remove_licenses` until step 4 is recorded complete, which is the constraint that
actually matters. Only the keystrokes are manual; the guardrail is not.

Confirm against the real tenant before planning. If a conversion API does turn out to be
reachable there, step 4 becomes a normal automated step and nothing else in this design changes.

### Rename convention

Step 3 renames `displayName` only. The UPN is left alone: renaming it breaks mailbox resolution
and makes the audit trail hard to follow, and the runbook says "change name on account", not
"change sign-in address".

## Feature gating

Two gates, both required: the shared provisioning tenant configuration (`M365_PROV_ENABLED` plus
credentials, UPN domain and baseline SKUs), AND `M365_OFFBOARD_ENABLED`.

The second exists because a single shared flag would mean switching on onboarding also arms
account teardown — sweeper included — on the same deploy. Requiring both keeps the original
safety property (no tenant credentials, no teardown, whatever a flag says) while letting the
constructive half be enabled on its own.

## Blockers

The planner refuses to produce an executable plan when:

- `legal_hold` is set and the plan would touch the mailbox or licenses;
- the account cannot be found in the tenant;
- the account is already disabled AND renamed (already offboarded — refuse rather than re-run);
- the account is privileged (holds directory roles) and no 7-year retention record exists
  (phase 2 supplies the record; until then this blocker is inert by configuration, not by
  being absent from the code).

Blockers are reported, never silently dropped — same contract as the provisioning planner.

## Scheduling, and one deliberate inversion

The approved plan persists with `scheduled_for` (`timestamptz`) and run status `scheduled`. A
sweeper job — same shape as the existing Cloud PC poller and CAB deadline sweeper — claims due
runs and executes them.

Intake must capture **date, time, and timezone**. The existing `m365_offboard` form has
`disable_effective` as a bare `date`, which cannot express "block them at 5pm Friday" and must
be widened.

**The inversion:** onboarding re-plans at execute time and refuses the run on fingerprint
mismatch, because creating the wrong account is worse than creating nothing. Offboarding is the
reverse — *failing to disable a terminated employee is the dangerous outcome*. So on mismatch at
fire time:

- steps 1–2 (`block_signin`, `revoke_sessions`) execute — they are security-critical and destroy
  no data;
- steps 3–6 halt for human review, and the run lands in a `needs_review` status.

This is a deliberate departure from the provisioning contract and is written down here so a
future reader does not "fix" it into consistency.

## Detection vs prompts

Auto-detected via Graph functions that already exist in
`integrations/m365/provisioning-graph.ts` (`findUserByUpn`, `directoryRoleCount`,
`userLicenseSkuIds`, `listGroupsByDisplayName`): privileged status, held licenses, group and DL
memberships, mailbox type, already-disabled state. Owned CIs come from the Nexus CMDB.

Prompted, split by who knows and when:

- **At intake (HR / manager):** disable date+time+timezone, legal hold, data disposition,
  forward-to, last day.
- **At fulfillment (the tech, while working):** partner/customer-issued equipment and which
  partners to notify, badge, security token, Nextiva/VOIP, VPN, whether a shipping label is
  needed.

Asking a tech about legal hold, or HR about a security token, is how prompts become
rubber-stamps. The split is the point.

## PII

A shipping label needs a home address. That is precisely the class of answer
`catalog-request-pii` exists to keep out of `tickets.custom_fields`, which is returned wholesale
and feeds webhooks and notifications. Shipping address and personal contact details route to
`ticket_sensitive_fields` through the existing sensitive-fields path, exactly as the onboarding
intake does.

## Evidence

Each executed step records what it actually did into `provisioning_steps` — Graph object ids,
the specific SKUs reclaimed, the specific groups removed. Prompt answers record the answering
user and a timestamp. This is what the phase-4 HR completion report reads from, so that
"report to HR, note any exceptions" is a generated artifact rather than a memory exercise.

No credential, token, or password appears in any response or log — carried over from the
provisioning engine's rule.

## Testing

Mirrors the provisioning suite's split:

- **Planner (pure, no I/O):** ordering constraint holds under every input permutation; shared
  mailbox conversion is never emitted after license removal; each blocker fires; privileged
  detection drives the conditional steps.
- **Executor (pure, injected ops):** refuses out-of-order plans; refuses blocker-carrying plans
  before any op runs; records per-step evidence; partial failure leaves earlier steps recorded.
- **Service (mocked DB/Graph):** one planning path for preview and execute; fingerprint mismatch
  at fire time executes 1–2 and halts 3–6; feature stays dark when disabled; in-flight guard.
- **Scheduler:** a due run is claimed exactly once under concurrent sweepers.

## Out of scope for phase 1

- **Phase 2 — retention holds:** privileged classification, retain-until stamping (1yr standard /
  7yr privileged), refusal of any flow that would delete before that date, alerting on
  eligibility. No automatic deletion: a cron job destroying seven-year federal records
  unattended is not supervisable.
- **Phase 3 — CMDB asset returns:** return checklist generated from the departing user's CIs,
  marked back as items arrive, so "update inventory" is a side effect of working the ticket.
- **Phase 4 — notifications:** partner/customer access-termination notices, and the HR
  completion report with exceptions.

The `<inactive_name>` format is `ZZ_Inactive_<Last>_<First>_<YYYY-MM-DD>` — e.g.
`ZZ_Inactive_Doe_Jane_2026-09-02`, using the last day, not the date the rename ran. The `ZZ_`
prefix sorts departed accounts to the bottom of every admin list, the name stays searchable, and
the embedded date makes the 1yr/7yr retention clock readable off the account itself without a
lookup. The planner builds this string; it is never typed by hand.

## Open questions

- Whether GCC High exposes any mailbox-conversion API that would let step 4 be automated after
  all. Assumed no (see "Step 4 is not automatable in phase 1"); worth one probe against the
  tenant, but the design does not depend on the answer.

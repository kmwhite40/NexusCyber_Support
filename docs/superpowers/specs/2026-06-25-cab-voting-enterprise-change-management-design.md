# Enterprise Change Management + CAB Voting — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan
**Area:** `/changes` page, `apps/api/src/modules/changes.ts`, new CAB subsystem

## Problem

The current change-management feature is functional but minimal:

- CAB approval reuses the generic `approvals` / `approval_steps` tables (sequential,
  **all-must-approve**; any single reject kills the change). The same tables back
  elevation and automation approvals.
- The web page hardcodes the CAB to a **single self-approver**
  (`approverIds: [me.id]`) — there is no real board.
- Scheduling is a hardcoded "tomorrow 02:00"; window conflicts are computed but
  **never surfaced** to the user.
- No deliberation thread, no notifications to voters, no vote deadline, no risk
  scoring, no structured implementation/test/backout plans, no post-implementation
  review, no emergency (ECAB) path, no blackout windows, no templates.

The goal: bring `/changes` to enterprise (ITIL-aligned) standard and let the CAB
("charter") **vote** on changes — quorum + majority — with a configurable standing
board.

## Decisions (from brainstorming)

1. **Decision rule:** quorum + majority. A configurable board votes
   Approve / Reject / Abstain; a quorum must be reached; the change passes on a
   configurable threshold (`majority`, `two_thirds`, or `unanimous`).
2. **Board config:** a **standing board per org** (members, chair, quorum,
   threshold) used by default for normal changes, **plus** the ability to add
   ad-hoc reviewers (e.g., the app owner) to a specific change.
3. **Scope:** all four enterprise bundles are in — Deliberation & notifications;
   Risk, plans & PIR; Scheduling & calendar; Emergency (ECAB) & templates.
4. **Architecture:** Approach A — a **dedicated CAB voting subsystem** (new tables),
   rather than overloading the shared `approvals` / `approval_steps` (which would
   leak quorum/abstain semantics into the unrelated elevation/automation flows).

## Org scope

Boards, blackouts, and templates are **org-scoped with an `organization_id IS NULL`
global default**, matching the platform's existing `org-NULL = global` convention
(KB spaces, queues). Changes remain per-customer-org (existing RLS on
`organization_id`). Nexus all-orgs admins manage the global default board; a
per-customer admin can configure that org's own board.

## Data model

### New tables

**`cab_boards`**
```
id              uuid pk
organization_id uuid null            -- null = global default
name            text not null
chair_id        uuid references users(id)
quorum          int  not null         -- minimum votes cast to resolve
threshold       text not null check (threshold in ('majority','two_thirds','unanimous'))
is_default      bool not null default false
created_at, updated_at timestamptz
```
Partial unique index: one default per org
(`unique (organization_id) where is_default`, with a separate partial for the
global `organization_id is null` default). RLS mirrors `changes`.

**`cab_board_members`**
```
id        uuid pk
board_id  uuid references cab_boards(id) on delete cascade
user_id   uuid references users(id)
role      text not null check (role in ('chair','member')) default 'member'
weight    int  not null default 1     -- reserved for future weighted voting; unused now
added_at  timestamptz
unique (board_id, user_id)
```

**`change_votes`** — one row **per eligible voter, snapshotted at submit time**
(roster = standing board members + ad-hoc additions):
```
id              uuid pk
organization_id uuid not null
change_id       uuid references changes(id) on delete cascade
voter_id        uuid references users(id)
vote            text null check (vote in ('approve','reject','abstain'))  -- null = pending
reason          text
weight          int not null default 1
ad_hoc          bool not null default false
decided_at      timestamptz
unique (change_id, voter_id)
```
Quorum/threshold are computed from these rows. Pending = `vote IS NULL`.

**`change_comments`** — deliberation thread:
```
id, organization_id, change_id (fk, cascade), author_id, body text, created_at
```

**`change_blackouts`** — freeze windows scheduling is checked against:
```
id, organization_id (null=global), name, starts_at, ends_at, reason, created_by, created_at
```

**`change_templates`** — prefill for common (esp. standard/pre-approved) changes:
```
id, organization_id (null=global), name, change_type, risk, impact, likelihood,
description, implementation_plan, test_plan, backout_plan, created_at
```

### `changes` table additions (ALTER)

```
implementation_plan text
test_plan           text          -- backout_plan already exists
impact              text check (impact in ('low','medium','high'))
likelihood          text check (likelihood in ('low','medium','high'))
                                  -- risk auto-derived from impact x likelihood, overridable (risk col exists)
cab_board_id        uuid references cab_boards(id)
cab_quorum          int           -- snapshot at submit (board edits don't alter in-flight votes)
cab_threshold       text          -- snapshot at submit
vote_deadline       timestamptz
pir_outcome         text check (pir_outcome in ('successful','failed','rolled_back','partial'))
pir_notes           text
pir_by              uuid references users(id)
pir_at              timestamptz
```

New status value `cancelled` added to the existing CHECK (withdrawn changes).

## Voting & state logic (pure, unit-tested)

All resolution logic is **pure functions** in `changes.ts` (like the existing
`detectWindowConflicts` / `allStepsApproved`), so it is unit-testable without a DB.

- **Quorum met:** `(approve + reject + abstain) >= cab_quorum`.
- **Threshold** over *cast, non-abstain* votes (`A` = approve, `R` = reject):
  - `majority`: `A > R`
  - `two_thirds`: `A >= ceil(2 * (A + R) / 3)` (and `A + R > 0`)
  - `unanimous`: `R == 0` and every non-abstaining roster member voted approve
- **Resolution** (evaluated on each vote):
  - finalize **approved** when quorum met AND threshold passes;
  - finalize **rejected** when quorum met AND threshold can no longer pass, or all
    roster members have voted;
  - else remain in `cab_review`.
  - Includes an "outcome mathematically decided → finalize early" check (remaining
    pending votes cannot change the result).
- Votes are weight-aware in the math (`weight` summed instead of counted), but all
  weights default to 1, so today it is one-member-one-vote.

### State machine

Unchanged statuses plus `cancelled`:
`draft → cab_review → approved → scheduled → implementing → review → closed`
(`rejected`, `cancelled` terminal). Differences from today:

- The `cab_review` gate calls the **voting resolver** instead of `allStepsApproved`.
- `review → closed` **requires a PIR outcome** to be recorded.
- **Emergency** changes route to an **ECAB roster** (chair + 1 member) with a short
  `vote_deadline`, and **mandate** a PIR.
- `draft`/`cab_review`/`approved`/`scheduled` may transition to `cancelled`.

## Permissions (new)

- `change.vote` — cast a CAB vote; granted to board-eligible roles alongside the
  existing `change.approve` (SecurityAnalyst, Tier3-equivalent, OrgAdmin).
- `cab.manage` — configure the board, blackouts, and templates (OrgAdmin + nexus
  all-orgs).

Actual voting eligibility is gated on **board membership for that change** (a
`change_votes` row exists for the actor) AND holding `change.vote`.

## API surface

New module `apps/api/src/modules/cab.ts` for board/blackout/template admin;
voting + lifecycle extend `changes.ts`.

**Board / config admin** (`cab.manage`):
- `GET /api/v1/cab/board` — the org's standing board (members, chair, quorum, threshold)
- `PUT /api/v1/cab/board` — configure it
- `GET/POST/DELETE /api/v1/cab/blackouts`
- `GET/POST/DELETE /api/v1/cab/templates`

**Change lifecycle** (extends existing routes):
- `POST /api/v1/changes` — accepts `impact`, `likelihood`, plan fields, optional `templateId`
- `POST /api/v1/changes/:id/submit-cab` — snapshots roster (standing board +
  `extraVoterIds[]`) into `change_votes`; snapshots `cab_quorum`/`cab_threshold`;
  sets `vote_deadline`. Standard changes still auto-approve (no CAB).
- `POST /api/v1/changes/:id/vote` — `{ vote, reason? }`; gated on membership +
  `change.vote`; runs resolver, may finalize. **Replaces** `cab-decision`.
- `GET/POST /api/v1/changes/:id/comments` — deliberation thread
- `POST /api/v1/changes/:id/schedule` — real start/end; returns conflicts **and**
  blackout hits (surfaced, not silent)
- `POST /api/v1/changes/:id/cancel` — withdraw
- `POST /api/v1/changes/:id/pir` — record post-implementation review
- `GET /api/v1/changes/calendar` — also returns blackout bands

## Page redesign

`apps/web/app/(app)/changes/page.tsx` (today one ~312-line file) is split into
focused components under `app/(app)/changes/_components/`:
`ChangeList`, `ChangeDetail`, `VotePanel`, `CabBoardSettings`, `ChangeCalendar`,
`BlackoutBar`.

The detail panel gains:
- **Vote tally widget** — live 👍/👎/➖ counts, quorum progress
  ("4 of 5 cast · quorum met"), threshold + deadline, per-member status, and
  **Approve / Reject / Abstain** buttons for eligible voters.
- **Deliberation thread**.
- **Structured plan tabs** — Implementation / Test / Backout.
- **Risk badge** derived from impact × likelihood.
- **PIR form** shown on close.
- A **CAB Settings** tab (board, blackouts, templates) for `cab.manage`.
- Calendar shows **blackout bands** and a real scheduling dialog with
  conflict/blackout warnings.

## Notifications & events

Reuse the existing `publish()` event bus + notifications module:
- `change.cab_requested` → notify each board member ("vote requested")
- `change.vote_cast` → notify chair
- `change.approved` / `change.rejected` → notify creator
- `change.scheduled` → reminder
- **Deadline escalation:** a scheduled check (existing job pattern) escalates to the
  chair when `vote_deadline` passes with quorum unmet.

## Testing

- **Unit (pure):** the voting resolver (quorum; majority / two-thirds / unanimous;
  abstain handling; early-finalize), risk derivation, and blackout/conflict
  detection — mirroring the existing `detectWindowConflicts` / `allStepsApproved`
  tests.
- **Integration:** submit → vote → finalize (approve and reject paths); ECAB path;
  schedule-into-blackout rejection; PIR-required-to-close. Follows the existing
  `apps/api/test/integration` pattern.

## Phased rollout (each phase shippable + deployable)

1. **Board + voting core** — tables, resolver, board config UI, vote panel
   (replaces the unanimous approval-steps usage).
2. **Deliberation + notifications** — comments thread, vote-requested
   notifications, deadline escalation.
3. **Risk, plans & PIR** — structured fields, risk scoring, PIR on close.
4. **Scheduling & calendar** — real scheduler, conflict/blackout surfacing,
   blackout bands.
5. **ECAB + templates** — emergency roster, mandatory retro PIR, templates.

## Backward compatibility

A data migration seeds a **default board per existing org** from current
`change.approve` holders, so in-flight changes keep working. The migration carries
the new tables/columns to existing/prod databases (applied on API boot, per the
project's migrate-on-boot pattern); article-style dual-write does not apply here
since change data is operational, not seeded content.

## Non-goals (YAGNI)

- Weighted voting UI (the `weight` column exists but stays 1).
- Cross-org / global CAB quorum spanning multiple customers.
- External CAB members (non-platform users).
- Automated risk scoring beyond the impact × likelihood matrix.

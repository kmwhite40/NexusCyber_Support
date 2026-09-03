# Enterprise Change Management + CAB Voting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare-bones CAB approval with an enterprise change-management subsystem: quorum + threshold voting by a configurable standing board, deliberation, risk/plans/PIR, real scheduling with blackout/conflict surfacing, and an emergency (ECAB) path with templates.

**Architecture:** Dedicated CAB voting subsystem (Approach A). New tables `cab_boards`, `cab_board_members`, `change_votes`, `change_comments`, `change_blackouts`, `change_templates`; `changes` gains plan/risk/PIR/snapshot columns. Pure, unit-tested resolver functions decide quorum/threshold. New `cab.ts` module for board/blackout/template admin; voting + lifecycle extend `changes.ts`. UI splits the monolithic page into focused components.

**Tech Stack:** TypeScript, Fastify, node-postgres (raw SQL + RLS), Zod, Vitest; Next.js 15 (App Router) + React 18 + Tailwind; forward-only SQL migrations applied on API boot.

**Reference spec:** `docs/superpowers/specs/2026-06-25-cab-voting-enterprise-change-management-design.md`

---

## File structure

**API**
- `apps/api/src/db/migrations/0050_cab_voting.sql` — all new tables + `changes` ALTERs + permissions + seed default boards (idempotent).
- `apps/api/src/modules/changes.ts` — extend: voting resolver (pure), `submitForCab` (snapshot roster), `castVote` (replaces `cabDecision`), `cancelChange`, `recordPir`, comments, risk derivation, blackout-aware `scheduleChange`.
- `apps/api/src/modules/cab.ts` — NEW: board CRUD, blackout CRUD, template CRUD, roster resolution.
- `apps/api/src/http/routes.ts` — new/changed routes under the existing Change block.
- `apps/api/src/modules/notifications-recipients.ts` / `notifications-templates.ts` / `notifications.ts` — add change/CAB events.
- `apps/api/src/jobs/cab-deadline-sweeper.ts` — NEW: escalate stalled votes past `vote_deadline`.
- `apps/api/src/db/seed.ts` — add `change.vote` + `cab.manage` permissions to PERMISSIONS + roles.

**Tests**
- `apps/api/test/changes.test.ts` — extend with resolver unit tests.
- `apps/api/test/cab.test.ts` — NEW: risk derivation, blackout detection unit tests.
- `apps/api/test/integration/cab-voting.int.test.ts` — NEW: submit→vote→finalize, ECAB, blackout schedule, PIR-required.

**Web**
- `apps/web/app/(app)/changes/page.tsx` — slim container; tab switch list/calendar/settings.
- `apps/web/app/(app)/changes/_components/ChangeList.tsx`
- `apps/web/app/(app)/changes/_components/ChangeDetail.tsx`
- `apps/web/app/(app)/changes/_components/VotePanel.tsx`
- `apps/web/app/(app)/changes/_components/CabBoardSettings.tsx`
- `apps/web/app/(app)/changes/_components/ChangeCalendar.tsx` (moved from page.tsx)
- `apps/web/lib/changes.ts` — typed API client helpers + shared types.

---

## PHASE 1 — Board + voting core

### Task 1: Voting resolver (pure functions, TDD)

**Files:**
- Modify: `apps/api/src/modules/changes.ts`
- Test: `apps/api/test/changes.test.ts`

- [ ] **Step 1: Write failing tests** — append to `apps/api/test/changes.test.ts`:

```ts
import { tallyVotes, resolveVote, deriveRisk } from '../src/modules/changes.js';

describe('tallyVotes', () => {
  it('counts approve/reject/abstain/pending with weights', () => {
    const t = tallyVotes([
      { vote: 'approve', weight: 1 }, { vote: 'approve', weight: 1 },
      { vote: 'reject', weight: 1 }, { vote: 'abstain', weight: 1 },
      { vote: null, weight: 1 },
    ]);
    expect(t).toEqual({ approve: 2, reject: 1, abstain: 1, pending: 1, cast: 4, roster: 5 });
  });
});

describe('resolveVote', () => {
  const roster = (votes: Array<string | null>) => votes.map((v) => ({ vote: v as any, weight: 1 }));

  it('stays in review until quorum is met', () => {
    expect(resolveVote(roster(['approve', null, null, null, null]), { quorum: 3, threshold: 'majority' })).toBe('cab_review');
  });
  it('approves on majority once quorum met', () => {
    expect(resolveVote(roster(['approve', 'approve', 'reject', null, null]), { quorum: 3, threshold: 'majority' })).toBe('approved');
  });
  it('rejects when threshold can no longer pass', () => {
    expect(resolveVote(roster(['reject', 'reject', 'reject', null, null]), { quorum: 3, threshold: 'majority' })).toBe('rejected');
  });
  it('abstain counts to quorum but not to for/against', () => {
    expect(resolveVote(roster(['approve', 'abstain', 'abstain', null, null]), { quorum: 3, threshold: 'majority' })).toBe('approved');
  });
  it('two_thirds requires >= ceil(2/3) of cast non-abstain', () => {
    expect(resolveVote(roster(['approve', 'approve', 'reject']), { quorum: 3, threshold: 'two_thirds' })).toBe('approved');
    expect(resolveVote(roster(['approve', 'reject', 'reject']), { quorum: 3, threshold: 'two_thirds' })).toBe('rejected');
  });
  it('unanimous requires zero rejects and all non-abstainers approved', () => {
    expect(resolveVote(roster(['approve', 'approve', 'approve']), { quorum: 3, threshold: 'unanimous' })).toBe('approved');
    expect(resolveVote(roster(['approve', 'approve', 'reject']), { quorum: 3, threshold: 'unanimous' })).toBe('rejected');
  });
});

describe('deriveRisk', () => {
  it('maps impact x likelihood to low/medium/high', () => {
    expect(deriveRisk('low', 'low')).toBe('low');
    expect(deriveRisk('high', 'low')).toBe('medium');
    expect(deriveRisk('high', 'high')).toBe('high');
  });
});
```

- [ ] **Step 2: Run, verify fail** — `cd apps/api && npx vitest run test/changes.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement** — add to `apps/api/src/modules/changes.ts`:

```ts
export type VoteValue = 'approve' | 'reject' | 'abstain';
export type Threshold = 'majority' | 'two_thirds' | 'unanimous';
export interface VoteRow { vote: VoteValue | null; weight: number }

export interface Tally { approve: number; reject: number; abstain: number; pending: number; cast: number; roster: number }

/** Weighted tally of a vote roster. Pure. */
export function tallyVotes(rows: VoteRow[]): Tally {
  const t: Tally = { approve: 0, reject: 0, abstain: 0, pending: 0, cast: 0, roster: 0 };
  for (const r of rows) {
    const w = r.weight ?? 1;
    t.roster += w;
    if (r.vote === 'approve') { t.approve += w; t.cast += w; }
    else if (r.vote === 'reject') { t.reject += w; t.cast += w; }
    else if (r.vote === 'abstain') { t.abstain += w; t.cast += w; }
    else t.pending += w;
  }
  return t;
}

/** Does the for/against split pass the threshold right now? Pure. */
function thresholdPasses(a: number, r: number, threshold: Threshold, decidedAll: boolean): boolean {
  if (a + r === 0) return false;
  if (threshold === 'majority') return a > r;
  if (threshold === 'two_thirds') return a >= Math.ceil((2 * (a + r)) / 3);
  // unanimous: any reject fails; otherwise pass once everyone non-abstaining has voted
  return r === 0 && decidedAll;
}

/**
 * Resolve a change's CAB status from its vote roster. Pure.
 * Returns 'approved' | 'rejected' | 'cab_review' (still open).
 */
export function resolveVote(rows: VoteRow[], cfg: { quorum: number; threshold: Threshold }): ChangeStatus {
  const t = tallyVotes(rows);
  const quorumMet = t.cast >= cfg.quorum;
  const allVoted = t.pending === 0;
  // Best/worst case for approvals if all pending voted one way (quorum permitting).
  const maxApprove = t.approve + t.pending;
  const decidedAll = allVoted || t.pending === 0;
  if (quorumMet && thresholdPasses(t.approve, t.reject, cfg.threshold, allVoted)) return 'approved';
  // Rejected once it is mathematically impossible to pass even if all pending approve.
  const canStillPass = thresholdPasses(maxApprove, t.reject, cfg.threshold, true);
  if ((quorumMet && allVoted) || !canStillPass) {
    // only reject if we at least could have met quorum; an all-abstain stalled vote stays open
    if (t.approve + t.reject > 0) return 'rejected';
  }
  if (quorumMet && allVoted && t.approve + t.reject === 0) return 'rejected'; // all-abstain, quorum met
  return 'cab_review';
}

const RISK_MATRIX: Record<string, Record<string, 'low' | 'medium' | 'high'>> = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'high' },
};
/** Impact x likelihood -> risk band. Pure. */
export function deriveRisk(impact: 'low' | 'medium' | 'high', likelihood: 'low' | 'medium' | 'high') {
  return RISK_MATRIX[impact][likelihood];
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run test/changes.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(changes): pure CAB voting resolver + risk derivation"`

### Task 2: Migration — tables, columns, permissions, seed default boards

**Files:** Create `apps/api/src/db/migrations/0050_cab_voting.sql`

- [ ] **Step 1: Write the migration** (idempotent; full DDL):

```sql
-- Enterprise change management + CAB quorum voting. Dedicated voting subsystem
-- (does not overload approvals/approval_steps). See spec 2026-06-25.

CREATE TABLE IF NOT EXISTS cab_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global default
  name text NOT NULL,
  chair_id uuid REFERENCES users(id),
  quorum int NOT NULL DEFAULT 1 CHECK (quorum >= 1),
  threshold text NOT NULL DEFAULT 'majority' CHECK (threshold IN ('majority','two_thirds','unanimous')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cab_boards_org_default ON cab_boards(organization_id) WHERE is_default AND organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cab_boards_global_default ON cab_boards((1)) WHERE is_default AND organization_id IS NULL;

CREATE TABLE IF NOT EXISTS cab_board_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES cab_boards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('chair','member')),
  weight int NOT NULL DEFAULT 1 CHECK (weight >= 1),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS change_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  change_id uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  voter_id uuid NOT NULL REFERENCES users(id),
  vote text CHECK (vote IN ('approve','reject','abstain')),
  reason text,
  weight int NOT NULL DEFAULT 1,
  ad_hoc boolean NOT NULL DEFAULT false,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_id, voter_id)
);
CREATE INDEX IF NOT EXISTS ix_change_votes_change ON change_votes(change_id);

CREATE TABLE IF NOT EXISTS change_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  change_id uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_change_comments_change ON change_comments(change_id);

CREATE TABLE IF NOT EXISTS change_blackouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS change_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  name text NOT NULL,
  change_type text NOT NULL DEFAULT 'standard' CHECK (change_type IN ('standard','normal','emergency')),
  risk text DEFAULT 'low' CHECK (risk IN ('low','medium','high')),
  impact text CHECK (impact IN ('low','medium','high')),
  likelihood text CHECK (likelihood IN ('low','medium','high')),
  description text,
  implementation_plan text,
  test_plan text,
  backout_plan text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- changes table additions
ALTER TABLE changes ADD COLUMN IF NOT EXISTS implementation_plan text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS test_plan text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS impact text CHECK (impact IN ('low','medium','high'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS likelihood text CHECK (likelihood IN ('low','medium','high'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_board_id uuid REFERENCES cab_boards(id);
ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_quorum int;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_threshold text CHECK (cab_threshold IN ('majority','two_thirds','unanimous'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS vote_deadline timestamptz;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_outcome text CHECK (pir_outcome IN ('successful','failed','rolled_back','partial'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_notes text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_by uuid REFERENCES users(id);
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_at timestamptz;

-- add 'cancelled' status (CHECK is recreated)
ALTER TABLE changes DROP CONSTRAINT IF EXISTS changes_status_check;
ALTER TABLE changes ADD CONSTRAINT changes_status_check
  CHECK (status IN ('draft','cab_review','approved','scheduled','implementing','review','closed','rejected','cancelled'));

-- RLS + grants for the new tables (mirror changes_isolation)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cab_boards','change_votes','change_comments','change_blackouts','change_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %1$s_isolation ON %1$s
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id) OR organization_id IS NULL)
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id) OR organization_id IS NULL)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nexus_app', t);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END LOOP;
END $$;
-- cab_board_members has no organization_id; gate via its board.
ALTER TABLE cab_board_members ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY cab_board_members_isolation ON cab_board_members USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON cab_board_members TO nexus_app;

-- permissions
INSERT INTO permissions (key, domain) VALUES ('change.vote','change'), ('cab.manage','change')
  ON CONFLICT (key) DO NOTHING;
-- grant change.vote where change.approve exists; cab.manage to org-admin-ish roles
INSERT INTO role_permissions (role_id, permission_id)
  SELECT rp.role_id, p.id FROM role_permissions rp
    JOIN permissions src ON src.id = rp.permission_id AND src.key = 'change.approve'
    JOIN permissions p ON p.key = 'change.vote'
  ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
  SELECT rp.role_id, p.id FROM role_permissions rp
    JOIN permissions src ON src.id = rp.permission_id AND src.key = 'org.manage'
    JOIN permissions p ON p.key = 'cab.manage'
  ON CONFLICT DO NOTHING;

-- seed a default board per existing org from current change.approve holders
DO $$
DECLARE o record; b uuid;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    IF NOT EXISTS (SELECT 1 FROM cab_boards WHERE organization_id = o.id AND is_default) THEN
      INSERT INTO cab_boards (organization_id, name, quorum, threshold, is_default)
        VALUES (o.id, 'Change Advisory Board', 1, 'majority', true) RETURNING id INTO b;
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 2: Apply** — `DATABASE_URL="postgres://nexus:nexus@localhost:5544/nexus" ./node_modules/.bin/tsx src/db/migrate.ts` → "apply 0050_cab_voting.sql … migrations complete".
- [ ] **Step 3: Verify** — `docker exec nexus-db psql -U nexus -d nexus -c "\d change_votes"` and `SELECT key FROM permissions WHERE key IN ('change.vote','cab.manage');` → both present.
- [ ] **Step 4: Commit** — `git commit -m "feat(db): CAB voting subsystem schema + permissions (0050)"`

### Task 3: `cab.ts` module — board/blackout/template CRUD + roster

**Files:** Create `apps/api/src/modules/cab.ts`; modify `apps/api/src/db/seed.ts` (PERMISSIONS + role grants for `change.vote`, `cab.manage` so fresh seeds match the migration).

- [ ] **Step 1:** Add to `seed.ts` PERMISSIONS array: `['change.vote','change'], ['cab.manage','change'],` and add `change.vote` to roles that have `change.approve`, `cab.manage` to OrgAdmin role perms.
- [ ] **Step 2:** Implement `cab.ts` with: `getBoard(actor, orgId)`, `putBoard(actor, input)` (upsert board + members, `cab.manage`), `resolveRoster(sql, orgId)` (default board members), `listBlackouts/createBlackout/deleteBlackout`, `listTemplates/createTemplate/deleteTemplate`. Follow the `withOrgContext`/`authorize`/`audit` pattern from `changes.ts`. (Full code authored at implementation time, mirroring existing module style.)
- [ ] **Step 3:** Unit test `apps/api/test/cab.test.ts` for any pure helpers (e.g., blackout overlap reuses `detectWindowConflicts`).
- [ ] **Step 4: Commit** — `git commit -m "feat(cab): board, blackout, and template admin module"`

### Task 4: `changes.ts` voting wiring + routes

**Files:** Modify `apps/api/src/modules/changes.ts`, `apps/api/src/http/routes.ts`

- [ ] **Step 1:** `submitForCab` — load the org default board (or `cab_board_id` override), insert a `change_votes` row per board member + each `extraVoterIds` (ad_hoc), snapshot `cab_board_id/cab_quorum/cab_threshold`, set `vote_deadline` (normal: +3 business days; emergency: +4h), set status `cab_review`, publish `change.cab_requested`. Standard → auto-approve as today.
- [ ] **Step 2:** `castVote(actor, changeId, vote, reason)` — replaces `cabDecision`: verify a `change_votes` row exists for actor (else 403), `authorize(actor,'change.vote')`, update the row, load all rows, call `resolveVote`, and finalize `changes.status` + publish `change.approved`/`change.rejected` or stay `cab_review`. Audit each vote.
- [ ] **Step 3:** `castVote` for emergency builds the ECAB roster (chair + 1) at submit; no special logic in cast.
- [ ] **Step 4:** Add `cancelChange`, `recordPir` (sets pir_* and transitions `review→closed`; block `review→closed` in `transitionChange` unless pir_outcome set), `addComment`/`listComments`.
- [ ] **Step 5:** Routes: replace `POST /changes/:id/cab-decision` with `POST /changes/:id/vote`; add `POST /changes/:id/cancel`, `POST /changes/:id/pir`, `GET/POST /changes/:id/comments`, `GET/PUT /cab/board`, `GET/POST/DELETE /cab/blackouts`, `GET/POST/DELETE /cab/templates`. Zod-validate all bodies.
- [ ] **Step 6:** Extend `createChange` to accept `impact/likelihood/implementationPlan/testPlan/templateId`; derive `risk` via `deriveRisk` when impact+likelihood given.
- [ ] **Step 7: Commit** — `git commit -m "feat(changes): quorum voting, comments, cancel, PIR endpoints"`

### Task 5: Integration tests

**Files:** Create `apps/api/test/integration/cab-voting.int.test.ts`

- [ ] Submit a normal change to a 3-member board (quorum 2, majority); two approvals → `approved`; assert. Another change: two rejects → `rejected`. Schedule into a blackout → response includes the blackout hit. `review→closed` without PIR → 409; with PIR → closed. Follow `apps/api/test/integration/elevation.int.test.ts` setup. Commit.

### Task 6: Web — split page + vote panel + board settings

**Files:** Modify `apps/web/app/(app)/changes/page.tsx`; create `_components/*` and `apps/web/lib/changes.ts`.

- [ ] **Step 1:** Extract `ChangeCalendar` and `ChangeList` from the current page into `_components/` (no behavior change); commit.
- [ ] **Step 2:** `VotePanel` — fetch `/changes/:id`, render tally (approve/reject/abstain/pending, quorum progress, threshold, deadline), per-member status, and Approve/Reject/Abstain buttons (calls `/changes/:id/vote`) shown when the user has a pending `change_votes` row. Optimistic refresh. Commit.
- [ ] **Step 3:** `ChangeDetail` — compose VotePanel + plan tabs (Implementation/Test/Backout) + risk badge + comments thread + PIR form (on `review`). Commit.
- [ ] **Step 4:** `CabBoardSettings` (tab, `cab.manage`) — edit board members/chair/quorum/threshold; manage blackouts + templates. Commit.
- [ ] **Step 5:** Wire the page container with `list | calendar | settings` tabs; typecheck `npx tsc --noEmit -p apps/web/tsconfig.json`. Commit.

---

## PHASE 2 — Deliberation + notifications

### Task 7: Notifications for CAB events

**Files:** Modify `notifications-recipients.ts`, `notifications-templates.ts`, `notifications.ts`.

- [ ] Add `change.cab_requested` (recipients: board member emails for the change), `change.vote_cast` (chair), `change.approved`/`change.rejected` (creator), `change.scheduled` (creator) to the `notifying` list + a recipient resolver + a template each. Add a unit test for the recipient resolver. Commit.

### Task 8: Deadline escalation job

**Files:** Create `apps/api/src/jobs/cab-deadline-sweeper.ts`; register where `sla-sweeper` is registered.

- [ ] Periodically find `cab_review` changes past `vote_deadline` with quorum unmet; publish `change.vote_overdue` (notifies chair). Mirror `sla-sweeper.ts` structure (interval + a pure "is overdue" predicate with a unit test). Commit.

---

## PHASE 3 — Risk, plans & PIR (mostly delivered in Phase 1)

### Task 9: Linked tickets / affected CIs + risk UI polish

**Files:** `changes.ts`, `ChangeDetail.tsx`.

- [ ] Surface `ticket_id` link and (if CMDB CIs available) an "affected services" multi-select stored on the change (reuse existing `ticket_id` FK; add a `change_cis` join table only if CMDB linkage is in scope — else show linked ticket only). Risk badge already from `deriveRisk`. Commit.

---

## PHASE 4 — Scheduling & calendar (conflict/blackout surfacing built in Phase 1 API)

### Task 10: Scheduling dialog + blackout bands

**Files:** `ChangeDetail.tsx`, `ChangeCalendar.tsx`.

- [ ] Replace hardcoded schedule with a date/time dialog calling `/changes/:id/schedule`; show returned conflicts + blackout hits inline with a confirm-anyway for conflicts (blackouts hard-block unless `cab.manage`). Calendar renders blackout bands from `/changes/calendar`. Commit.

---

## PHASE 5 — ECAB + templates

### Task 11: Emergency path + templates UI

**Files:** `changes.ts`, `ChangeDetail.tsx`, `CabBoardSettings.tsx`.

- [ ] Emergency changes: `submitForCab` builds ECAB roster (chair + 1), short deadline; `review→closed` requires PIR (already enforced). "New change from template" prefills the create form from `/cab/templates`. Commit.

---

## Deploy (after Phase 1 green, then per phase)

- [ ] Apply migration to prod via API boot (deploy-api). Build + deploy web. Verify `/changes` loads, board settings save, a test vote finalizes. (Uses `scripts/deploy-api.sh` + `scripts/deploy-web.sh`.)

## Self-review notes

- Spec coverage: voting (T1,T4), board config (T2,T3,T6), deliberation (T6,T7), notifications (T7,T8), risk/plans/PIR (T1,T4,T9), scheduling/blackouts (T2,T4,T10), ECAB/templates (T2,T11) — all mapped.
- Resolver edge cases (all-abstain, early-reject, unanimous) covered by Task 1 tests.
- Type consistency: `Threshold`, `VoteValue`, `resolveVote`, `tallyVotes`, `deriveRisk` defined in Task 1 and reused in Tasks 3/4.

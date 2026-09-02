# SBS Offboarding Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the M365 half of the SBS offboarding runbook behind a human-approved plan that fires at HR's scheduled disable time.

**Architecture:** A new `modules/offboarding/` engine mirroring the provisioning module's shape — pure planner, pure executor with injected ops, service layer owning all I/O — sharing the `provisioning_runs`/`provisioning_steps` tables via a `kind` discriminator. It deliberately does NOT extend the provisioning planner: that module's one-planning-path invariant protects onboarding, and offboarding is the destructive flow.

**Tech Stack:** TypeScript, Fastify, Postgres (RLS), Microsoft Graph (GCC High), Vitest, Next.js 15 / React 18 for the panel.

**Spec:** `docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md` — read it before Task 1. The plan argues from the spec; both travel together.

## Global Constraints

- Feature stays dark unless provisioning config is enabled — reuse `config.provisioning` and `provisioning.isEnabled()`; do NOT add a second feature flag.
- Step order is fixed and enforced: `block_signin` → `revoke_sessions` → `rename_account` → `convert_shared_mailbox` → `remove_licenses` → `remove_groups_dls_roles`. The planner emits this order or emits nothing.
- `convert_shared_mailbox` is a **prompted manual step** — Graph has no mailbox-conversion endpoint. It is NOT a Graph call. `remove_licenses` must not be emitted as executable until it is recorded complete.
- Rename format, exact: `ZZ_Inactive_<Last>_<First>_<YYYY-MM-DD>` using the **last day**, e.g. `ZZ_Inactive_Doe_Jane_2026-09-02`. `displayName` only — never the UPN.
- No credential, token, or password in any response, log, or DB column.
- Every DB write supplies `organization_id` — RLS is not inherited through foreign keys.
- Blockers are reported, never silently dropped.
- Personal address / contact answers route to `ticket_sensitive_fields`, never `tickets.custom_fields`.

---

### Task 1: Widen the runs tables for offboarding

**Files:**
- Create: `apps/api/src/db/migrations/0064_offboarding_runs.sql`
- Test: `apps/api/test/integration/offboarding-schema.int.test.ts`

**Interfaces:**
- Consumes: existing `provisioning_runs`, `provisioning_steps` (migration 0056).
- Produces: `provisioning_runs.kind` (`'onboarding'|'offboarding'`, default `'onboarding'`), `provisioning_runs.scheduled_for timestamptz NULL`, and two new run statuses `'scheduled'` and `'needs_review'`.

- [ ] **Step 1: Write the failing test**

```typescript
import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

describeDb('offboarding run schema', () => {
  it('accepts an offboarding run scheduled for a future instant', async () => {
    const ok = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'provisioning_runs' AND column_name IN ('kind','scheduled_for')
          ORDER BY column_name`,
      );
      return rows.map((r: { column_name: string }) => r.column_name);
    });
    expect(ok).toEqual(['kind', 'scheduled_for']);
  });

  it('allows the scheduled and needs_review statuses', async () => {
    const allowed = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'provisioning_runs'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%status%'`,
      );
      return rows.map((r: { def: string }) => r.def).join(' ');
    });
    expect(allowed).toContain('scheduled');
    expect(allowed).toContain('needs_review');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/offboarding-schema.int.test.ts`
Expected: FAIL — first test returns `[]` (no such columns).

Note: integration tests need a database. Bring one up first:
```bash
docker compose up -d db
cd apps/api && npx tsx --env-file ../../.env src/db/migrate.ts && npx tsx --env-file ../../.env src/db/seed.ts
```
The dev DB is on host port **5544**, not 5432, and without `--env-file ../../.env` these commands hit the wrong Postgres.

- [ ] **Step 3: Write the migration**

```sql
-- Offboarding shares the provisioning run tables: run history, in-flight guards and per-step
-- evidence are the same problem in both directions. `kind` is what keeps the two flows apart
-- in every query that must not mix them.
ALTER TABLE provisioning_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'onboarding',
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

ALTER TABLE provisioning_runs DROP CONSTRAINT IF EXISTS provisioning_runs_kind_check;
ALTER TABLE provisioning_runs ADD CONSTRAINT provisioning_runs_kind_check
  CHECK (kind IN ('onboarding','offboarding'));

COMMENT ON COLUMN provisioning_runs.scheduled_for IS
  'When an approved offboarding plan should fire. HR-specified instant, timezone-aware. NULL for onboarding, which runs immediately on approval.';

-- 'scheduled': approved and armed, waiting for scheduled_for.
-- 'needs_review': fired, security steps done, data-affecting steps halted on plan drift.
ALTER TABLE provisioning_runs DROP CONSTRAINT IF EXISTS provisioning_runs_status_check;
ALTER TABLE provisioning_runs ADD CONSTRAINT provisioning_runs_status_check
  CHECK (status IN ('planned','scheduled','running','awaiting_cloudpc','needs_review','succeeded','failed'));

-- The sweeper claims due runs with FOR UPDATE SKIP LOCKED; this index keeps that scan cheap
-- and is partial so it stays small as run history grows.
CREATE INDEX IF NOT EXISTS provisioning_runs_due_idx
  ON provisioning_runs (scheduled_for)
  WHERE status = 'scheduled';
```

- [ ] **Step 4: Apply and verify the test passes**

```bash
cd apps/api && npx tsx --env-file ../../.env src/db/migrate.ts
npx vitest run test/integration/offboarding-schema.int.test.ts
```
Expected: PASS, both tests.

- [ ] **Step 5: Confirm nothing else broke**

Run: `cd apps/api && npx vitest run`
Expected: all pass. The provisioning suites must be untouched — `kind` defaults to `'onboarding'`, so existing rows and inserts keep working unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/migrations/0064_offboarding_runs.sql apps/api/test/integration/offboarding-schema.int.test.ts
git commit -m "feat(offboarding): widen provisioning runs for offboarding kind and scheduling"
```

---

### Task 2: The rename convention, as a pure function

**Files:**
- Create: `apps/api/src/modules/offboarding/planner.ts`
- Test: `apps/api/test/offboarding-planner.test.ts`

**Interfaces:**
- Produces: `export function inactiveDisplayName(last: string, first: string, lastDay: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { inactiveDisplayName } from '../src/modules/offboarding/planner.js';

describe('inactiveDisplayName', () => {
  it('builds the agreed ZZ_Inactive format from the last day', () => {
    expect(inactiveDisplayName('Doe', 'Jane', '2026-09-02')).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
  });

  it('strips characters that would make the name unsearchable', () => {
    // Names arrive from a request form as free text. Spaces, commas and accents are normal;
    // underscores in the source would make the segments ambiguous to read back.
    expect(inactiveDisplayName('Van Der Berg', 'Anne-Marie', '2026-01-05'))
      .toBe('ZZ_Inactive_VanDerBerg_Anne-Marie_2026-01-05');
  });

  it('refuses a last day that is not an ISO date, rather than embedding junk in the name', () => {
    // This string is the only place the retention clock is readable off the account itself.
    expect(() => inactiveDisplayName('Doe', 'Jane', '09/02/2026')).toThrow(/ISO date/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/offboarding-planner.test.ts`
Expected: FAIL — cannot find module `offboarding/planner.js`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// Pure planning for offboarding. No I/O — the service layer supplies tenant state, exactly as
// modules/provisioning/planner.ts does. See docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The disabled-account naming convention: `ZZ_Inactive_<Last>_<First>_<YYYY-MM-DD>`.
 *
 * `ZZ_` sorts departed accounts to the bottom of every admin list; the embedded LAST DAY (not
 * the date the rename ran) makes the 1yr/7yr retention clock readable straight off the account
 * without a lookup. Underscore is the segment separator, so it is stripped from name parts —
 * otherwise `ZZ_Inactive_Van_Der_Berg_Anne_2026-01-05` cannot be parsed back apart.
 */
export function inactiveDisplayName(last: string, first: string, lastDay: string): string {
  if (!ISO_DATE.test(lastDay)) {
    throw new Error(`last day must be an ISO date (YYYY-MM-DD), got "${lastDay}"`);
  }
  const clean = (s: string) => s.replace(/[\s_]+/g, '').trim();
  return `ZZ_Inactive_${clean(last)}_${clean(first)}_${lastDay}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run test/offboarding-planner.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/offboarding/planner.ts apps/api/test/offboarding-planner.test.ts
git commit -m "feat(offboarding): the ZZ_Inactive rename convention as a pure function"
```

---

### Task 3: The planner — step set, ordering, blockers

**Files:**
- Modify: `apps/api/src/modules/offboarding/planner.ts`
- Test: `apps/api/test/offboarding-planner.test.ts`

**Interfaces:**
- Consumes: `inactiveDisplayName` from Task 2.
- Produces:
```typescript
export type OffboardStepKey =
  | 'block_signin' | 'revoke_sessions' | 'rename_account'
  | 'convert_shared_mailbox' | 'remove_licenses' | 'remove_groups_dls_roles';
export interface OffboardStep { key: OffboardStepKey; label: string; manual: boolean; detail: Record<string, unknown> }
export interface Blocker { code: string; message: string }
export interface OffboardPlan {
  upn: string; currentDisplayName: string; inactiveName: string;
  privileged: boolean; steps: OffboardStep[]; blockers: Blocker[];
}
export interface OffboardPlanInput {
  answers: Record<string, unknown>;
  user: { id: string; userPrincipalName: string; displayName: string; accountEnabled: boolean } | null;
  directoryRoleCount: number;
  licenseSkuIds: string[];
  groupIds: string[];
  mailboxType: 'user' | 'shared' | 'none';
}
export function planOffboard(input: OffboardPlanInput): OffboardPlan;
export const OFFBOARD_STEP_ORDER: OffboardStepKey[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { planOffboard, OFFBOARD_STEP_ORDER, type OffboardPlanInput } from '../src/modules/offboarding/planner.js';

const baseInput = (over: Partial<OffboardPlanInput> = {}): OffboardPlanInput => ({
  answers: { legal_first_name: 'Jane', legal_last_name: 'Doe', last_day: '2026-09-02' },
  user: { id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe', accountEnabled: true },
  directoryRoleCount: 0,
  licenseSkuIds: ['sku-e3'],
  groupIds: ['g-1'],
  mailboxType: 'user',
  ...over,
});

describe('planOffboard', () => {
  it('emits the six steps in the one order that preserves the mailbox', () => {
    const plan = planOffboard(baseInput());
    expect(plan.steps.map((s) => s.key)).toEqual(OFFBOARD_STEP_ORDER);
  });

  it('marks the mailbox conversion manual — Graph cannot do it', () => {
    const plan = planOffboard(baseInput());
    const convert = plan.steps.find((s) => s.key === 'convert_shared_mailbox');
    expect(convert?.manual).toBe(true);
    expect(plan.steps.filter((s) => s.manual).map((s) => s.key)).toEqual(['convert_shared_mailbox']);
  });

  it('never places license removal before the mailbox conversion', () => {
    const plan = planOffboard(baseInput());
    const keys = plan.steps.map((s) => s.key);
    expect(keys.indexOf('convert_shared_mailbox')).toBeLessThan(keys.indexOf('remove_licenses'));
  });

  it('skips the mailbox conversion when there is no user mailbox to convert', () => {
    const plan = planOffboard(baseInput({ mailboxType: 'none' }));
    expect(plan.steps.map((s) => s.key)).not.toContain('convert_shared_mailbox');
    // and license removal is still present and still last-but-one
    expect(plan.steps.map((s) => s.key)).toContain('remove_licenses');
  });

  it('flags a privileged account so the 7-year retention path applies', () => {
    const plan = planOffboard(baseInput({ directoryRoleCount: 2 }));
    expect(plan.privileged).toBe(true);
  });

  it('blocks on legal hold, because the plan would touch the mailbox and licenses', () => {
    const plan = planOffboard(baseInput({ answers: { ...baseInput().answers, legal_hold: true } }));
    expect(plan.blockers.map((b) => b.code)).toContain('legal_hold');
  });

  it('blocks when the account is not in the tenant', () => {
    const plan = planOffboard(baseInput({ user: null }));
    expect(plan.blockers.map((b) => b.code)).toContain('user_not_found');
  });

  it('blocks a re-run of an account already disabled and renamed', () => {
    const plan = planOffboard(baseInput({
      user: { id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'ZZ_Inactive_Doe_Jane_2026-09-02', accountEnabled: false },
    }));
    expect(plan.blockers.map((b) => b.code)).toContain('already_offboarded');
  });

  it('carries the computed inactive name so the executor never derives it', () => {
    expect(planOffboard(baseInput()).inactiveName).toBe('ZZ_Inactive_Doe_Jane_2026-09-02');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/offboarding-planner.test.ts`
Expected: FAIL — `planOffboard is not a function`.

- [ ] **Step 3: Implement the planner**

Append to `apps/api/src/modules/offboarding/planner.ts`:

```typescript
export type OffboardStepKey =
  | 'block_signin' | 'revoke_sessions' | 'rename_account'
  | 'convert_shared_mailbox' | 'remove_licenses' | 'remove_groups_dls_roles';

export interface OffboardStep { key: OffboardStepKey; label: string; manual: boolean; detail: Record<string, unknown> }
export interface Blocker { code: string; message: string }

export interface OffboardPlan {
  upn: string; currentDisplayName: string; inactiveName: string;
  privileged: boolean; steps: OffboardStep[]; blockers: Blocker[];
}

export interface OffboardPlanInput {
  answers: Record<string, unknown>;
  user: { id: string; userPrincipalName: string; displayName: string; accountEnabled: boolean } | null;
  directoryRoleCount: number;
  licenseSkuIds: string[];
  groupIds: string[];
  mailboxType: 'user' | 'shared' | 'none';
}

/**
 * THE ORDERING CONSTRAINT, in one place.
 *
 * A mailbox can only be converted to shared while it is still LICENSED. Remove the license
 * first and the mailbox drops into soft-delete and the conversion fails — destroying the very
 * artifact the runbook was preserving. revoke_sessions must follow block_signin or a live
 * session mints fresh tokens against a still-enabled account.
 */
export const OFFBOARD_STEP_ORDER: OffboardStepKey[] = [
  'block_signin', 'revoke_sessions', 'rename_account',
  'convert_shared_mailbox', 'remove_licenses', 'remove_groups_dls_roles',
];

export function planOffboard(input: OffboardPlanInput): OffboardPlan {
  const blockers: Blocker[] = [];
  const first = String(input.answers.legal_first_name ?? '');
  const last = String(input.answers.legal_last_name ?? '');
  const lastDay = String(input.answers.last_day ?? '');

  const privileged = input.directoryRoleCount > 0;

  let inactiveName = '';
  try {
    inactiveName = inactiveDisplayName(last, first, lastDay);
  } catch (e) {
    blockers.push({ code: 'bad_last_day', message: (e as Error).message });
  }

  if (!input.user) {
    blockers.push({ code: 'user_not_found', message: 'The account was not found in the tenant.' });
  } else if (!input.user.accountEnabled && input.user.displayName.startsWith('ZZ_Inactive_')) {
    blockers.push({
      code: 'already_offboarded',
      message: `${input.user.userPrincipalName} is already disabled and renamed; refusing to re-run.`,
    });
  }

  if (input.answers.legal_hold === true) {
    blockers.push({
      code: 'legal_hold',
      message: 'Legal hold is set: this plan would convert the mailbox and reclaim licenses.',
    });
  }

  // Only emit a conversion step when there is a user mailbox to convert. A shared or absent
  // mailbox has nothing to preserve, and emitting a manual step nobody can complete would
  // stall the run forever.
  const wantsConversion = input.mailboxType === 'user';

  const all: Record<OffboardStepKey, OffboardStep> = {
    block_signin: { key: 'block_signin', label: 'Block sign-in', manual: false, detail: { userId: input.user?.id } },
    revoke_sessions: { key: 'revoke_sessions', label: 'Revoke sessions and refresh tokens', manual: false, detail: { userId: input.user?.id } },
    rename_account: { key: 'rename_account', label: `Rename to ${inactiveName}`, manual: false, detail: { userId: input.user?.id, displayName: inactiveName } },
    convert_shared_mailbox: {
      key: 'convert_shared_mailbox',
      label: 'Convert mailbox to shared (manual — Exchange Online PowerShell)',
      manual: true,
      detail: { upn: input.user?.userPrincipalName },
    },
    remove_licenses: { key: 'remove_licenses', label: `Reclaim ${input.licenseSkuIds.length} license(s)`, manual: false, detail: { skuIds: input.licenseSkuIds } },
    remove_groups_dls_roles: { key: 'remove_groups_dls_roles', label: `Remove ${input.groupIds.length} group/DL membership(s) and directory roles`, manual: false, detail: { groupIds: input.groupIds, directoryRoleCount: input.directoryRoleCount } },
  };

  const steps = OFFBOARD_STEP_ORDER
    .filter((k) => (k === 'convert_shared_mailbox' ? wantsConversion : true))
    .map((k) => all[k]);

  return {
    upn: input.user?.userPrincipalName ?? '',
    currentDisplayName: input.user?.displayName ?? '',
    inactiveName, privileged, steps, blockers,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/offboarding-planner.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/offboarding/planner.ts apps/api/test/offboarding-planner.test.ts
git commit -m "feat(offboarding): planner with fixed step order and refusal blockers"
```

---

### Task 4: Plan fingerprint

**Files:**
- Modify: `apps/api/src/modules/offboarding/planner.ts`
- Test: `apps/api/test/offboarding-planner.test.ts`

**Interfaces:**
- Produces: `export function offboardFingerprint(plan: OffboardPlan): string`

- [ ] **Step 1: Write the failing tests**

```typescript
import { offboardFingerprint } from '../src/modules/offboarding/planner.js';

describe('offboardFingerprint', () => {
  it('is stable for the same plan', () => {
    const a = planOffboard(baseInput());
    const b = planOffboard(baseInput());
    expect(offboardFingerprint(a)).toBe(offboardFingerprint(b));
  });

  it('changes when the licenses to reclaim change', () => {
    const a = planOffboard(baseInput());
    const b = planOffboard(baseInput({ licenseSkuIds: ['sku-e3', 'sku-atp'] }));
    expect(offboardFingerprint(a)).not.toBe(offboardFingerprint(b));
  });

  it('changes when the groups to strip change', () => {
    const a = planOffboard(baseInput());
    const b = planOffboard(baseInput({ groupIds: ['g-1', 'g-2'] }));
    expect(offboardFingerprint(a)).not.toBe(offboardFingerprint(b));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/offboarding-planner.test.ts -t fingerprint`
Expected: FAIL — `offboardFingerprint is not a function`.

- [ ] **Step 3: Implement**

```typescript
import { createHash } from 'node:crypto';

/**
 * Binds an approved plan to the exact set of writes it authorises. The service refuses to
 * execute a plan whose freshly-rebuilt fingerprint differs — see the spec's inversion note for
 * what "refuses" means for offboarding specifically (security steps still run).
 *
 * Deliberately covers the DETAIL, not just the step keys: "remove 1 licence" and "remove 4
 * licences" are the same six steps and very different acts.
 */
export function offboardFingerprint(plan: OffboardPlan): string {
  const material = JSON.stringify({
    upn: plan.upn,
    inactiveName: plan.inactiveName,
    privileged: plan.privileged,
    steps: plan.steps.map((s) => [s.key, s.manual, s.detail]),
  });
  return createHash('sha256').update(material).digest('hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/offboarding-planner.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/offboarding/planner.ts apps/api/test/offboarding-planner.test.ts
git commit -m "feat(offboarding): fingerprint binding an approved plan to its exact writes"
```

---

### Task 5: Graph operations for offboarding

**Files:**
- Modify: `apps/api/src/integrations/m365/provisioning-graph.ts`
- Test: `apps/api/test/offboarding-graph.test.ts`

**Interfaces:**
- Consumes: `GraphClient` from `integrations/m365/graph-client.js`.
- Produces:
```typescript
export async function setAccountEnabled(g: GraphClient, userId: string, enabled: boolean): Promise<void>;
export async function revokeSignInSessions(g: GraphClient, userId: string): Promise<void>;
export async function setDisplayName(g: GraphClient, userId: string, displayName: string): Promise<void>;
export async function removeLicenses(g: GraphClient, userId: string, skuIds: string[]): Promise<void>;
export async function removeFromGroup(g: GraphClient, groupId: string, userId: string): Promise<void>;
export async function userGroupIds(g: GraphClient, userId: string): Promise<string[]>;
export async function mailboxType(g: GraphClient, upn: string): Promise<'user' | 'shared' | 'none'>;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  setAccountEnabled, revokeSignInSessions, setDisplayName, removeLicenses, removeFromGroup,
} from '../src/integrations/m365/provisioning-graph.js';

const clientDouble = () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    g: {
      patch: vi.fn(async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return {}; }),
      post: vi.fn(async (path: string, body?: unknown) => { calls.push({ method: 'POST', path, body }); return {}; }),
      del: vi.fn(async (path: string) => { calls.push({ method: 'DELETE', path }); return {}; }),
      get: vi.fn(async (path: string) => { calls.push({ method: 'GET', path }); return {}; }),
    } as any,
  };
};

describe('offboarding graph ops', () => {
  it('disables the account by PATCHing accountEnabled false', async () => {
    const { g, calls } = clientDouble();
    await setAccountEnabled(g, 'u-1', false);
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/users/u-1', body: { accountEnabled: false } });
  });

  it('revokes sessions through the dedicated action, not by password reset', async () => {
    const { g, calls } = clientDouble();
    await revokeSignInSessions(g, 'u-1');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/users/u-1/revokeSignInSessions' });
  });

  it('renames displayName only, never userPrincipalName', async () => {
    const { g, calls } = clientDouble();
    await setDisplayName(g, 'u-1', 'ZZ_Inactive_Doe_Jane_2026-09-02');
    expect(calls[0].body).toEqual({ displayName: 'ZZ_Inactive_Doe_Jane_2026-09-02' });
    expect(JSON.stringify(calls[0].body)).not.toContain('userPrincipalName');
  });

  it('removes every named license in one assignLicense call', async () => {
    const { g, calls } = clientDouble();
    await removeLicenses(g, 'u-1', ['sku-a', 'sku-b']);
    expect(calls[0]).toMatchObject({
      method: 'POST', path: '/users/u-1/assignLicense',
      body: { addLicenses: [], removeLicenses: ['sku-a', 'sku-b'] },
    });
  });

  it('does not call Graph at all when there are no licenses to remove', async () => {
    const { g, calls } = clientDouble();
    await removeLicenses(g, 'u-1', []);
    expect(calls).toEqual([]);
  });

  it('removes a group membership via the $ref endpoint', async () => {
    const { g, calls } = clientDouble();
    await removeFromGroup(g, 'g-1', 'u-1');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/groups/g-1/members/u-1/$ref' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/offboarding-graph.test.ts`
Expected: FAIL — `setAccountEnabled is not a function`.

- [ ] **Step 3: Implement**

Append to `apps/api/src/integrations/m365/provisioning-graph.ts`:

```typescript
// ---- Offboarding operations ----
// These are the destructive counterparts to createUser/assignLicenses/addToGroup above. They
// live in the same file because they speak to the same Graph surface with the same client, but
// nothing here is reachable from the onboarding planner or executor.

export async function setAccountEnabled(g: GraphClient, userId: string, enabled: boolean): Promise<void> {
  await g.patch(`/users/${userId}`, { accountEnabled: enabled });
}

/** The supported way to kill live sessions. A password reset does NOT invalidate refresh tokens. */
export async function revokeSignInSessions(g: GraphClient, userId: string): Promise<void> {
  await g.post(`/users/${userId}/revokeSignInSessions`);
}

/** displayName ONLY. Renaming the UPN breaks mailbox resolution and muddies the audit trail. */
export async function setDisplayName(g: GraphClient, userId: string, displayName: string): Promise<void> {
  await g.patch(`/users/${userId}`, { displayName });
}

export async function removeLicenses(g: GraphClient, userId: string, skuIds: string[]): Promise<void> {
  // An assignLicense call with an empty removeLicenses array is a pointless round trip that can
  // still fail; nothing to reclaim means nothing to call.
  if (skuIds.length === 0) return;
  await g.post(`/users/${userId}/assignLicense`, { addLicenses: [], removeLicenses: skuIds });
}

export async function removeFromGroup(g: GraphClient, groupId: string, userId: string): Promise<void> {
  await g.del(`/groups/${groupId}/members/${userId}/$ref`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/offboarding-graph.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Check the GraphClient actually exposes patch/post/del**

Run: `grep -nE "patch|post|del|get" apps/api/src/integrations/m365/graph-client.ts | head`
If any verb is missing, add it following the existing method's shape before proceeding — do not work around it in the ops.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/integrations/m365/provisioning-graph.ts apps/api/test/offboarding-graph.test.ts
git commit -m "feat(offboarding): Graph operations for disable, revoke, rename, delicense, degroup"
```

---

### Task 6: The executor

**Files:**
- Create: `apps/api/src/modules/offboarding/executor.ts`
- Test: `apps/api/test/offboarding-executor.test.ts`

**Interfaces:**
- Consumes: `OffboardPlan`, `OFFBOARD_STEP_ORDER` (Task 3).
- Produces:
```typescript
export interface OffboardOps {
  blockSignin(userId: string): Promise<void>;
  revokeSessions(userId: string): Promise<void>;
  rename(userId: string, displayName: string): Promise<void>;
  removeLicenses(userId: string, skuIds: string[]): Promise<void>;
  removeFromGroups(userId: string, groupIds: string[]): Promise<void>;
  recordStep(key: string, status: 'succeeded' | 'failed' | 'awaiting_manual', detail: Record<string, unknown>): Promise<void>;
}
export interface OffboardOutcome { key: string; status: string; error?: string }
export async function executeOffboardPlan(
  plan: OffboardPlan, userId: string, ops: OffboardOps, opts?: { onlySecuritySteps?: boolean },
): Promise<OffboardOutcome[]>;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { executeOffboardPlan, type OffboardOps } from '../src/modules/offboarding/executor.js';
import { planOffboard } from '../src/modules/offboarding/planner.js';

const opsDouble = () => {
  const order: string[] = [];
  const ops: OffboardOps = {
    blockSignin: vi.fn(async () => { order.push('blockSignin'); }),
    revokeSessions: vi.fn(async () => { order.push('revokeSessions'); }),
    rename: vi.fn(async () => { order.push('rename'); }),
    removeLicenses: vi.fn(async () => { order.push('removeLicenses'); }),
    removeFromGroups: vi.fn(async () => { order.push('removeFromGroups'); }),
    recordStep: vi.fn(async () => {}),
  };
  return { ops, order };
};

const plan = () => planOffboard({
  answers: { legal_first_name: 'Jane', legal_last_name: 'Doe', last_day: '2026-09-02' },
  user: { id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe', accountEnabled: true },
  directoryRoleCount: 0, licenseSkuIds: ['sku-e3'], groupIds: ['g-1'], mailboxType: 'user',
});

describe('executeOffboardPlan', () => {
  it('runs the automated steps in plan order', async () => {
    const { ops, order } = opsDouble();
    await executeOffboardPlan(plan(), 'u-1', ops);
    expect(order).toEqual(['blockSignin', 'revokeSessions', 'rename']);
  });

  it('halts at the manual mailbox step instead of stripping licenses behind it', async () => {
    // This is the whole point of the ordering rule: an unlicensed mailbox cannot be converted.
    const { ops, order } = opsDouble();
    const outcomes = await executeOffboardPlan(plan(), 'u-1', ops);
    expect(order).not.toContain('removeLicenses');
    expect(outcomes.find((o) => o.key === 'convert_shared_mailbox')?.status).toBe('awaiting_manual');
  });

  it('refuses a plan carrying blockers before performing any operation', async () => {
    const { ops, order } = opsDouble();
    const blocked = { ...plan(), blockers: [{ code: 'legal_hold', message: 'held' }] };
    await expect(executeOffboardPlan(blocked, 'u-1', ops)).rejects.toThrow(/blocker/i);
    expect(order).toEqual([]);
  });

  it('refuses a plan whose steps are out of order rather than trusting the caller', async () => {
    const { ops, order } = opsDouble();
    const p = plan();
    const scrambled = { ...p, steps: [...p.steps].reverse() };
    await expect(executeOffboardPlan(scrambled, 'u-1', ops)).rejects.toThrow(/order/i);
    expect(order).toEqual([]);
  });

  it('runs only the security steps when asked, for the scheduled-drift case', async () => {
    const { ops, order } = opsDouble();
    const outcomes = await executeOffboardPlan(plan(), 'u-1', ops, { onlySecuritySteps: true });
    expect(order).toEqual(['blockSignin', 'revokeSessions']);
    expect(outcomes.find((o) => o.key === 'rename_account')?.status).toBe('skipped');
  });

  it('records every step it performs, so evidence survives a later failure', async () => {
    const { ops } = opsDouble();
    await executeOffboardPlan(plan(), 'u-1', ops);
    expect(ops.recordStep).toHaveBeenCalledWith('block_signin', 'succeeded', expect.anything());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/offboarding-executor.test.ts`
Expected: FAIL — cannot find module `offboarding/executor.js`.

- [ ] **Step 3: Implement**

```typescript
// Pure-with-injected-ops execution. No Graph imports, no DB imports — everything the executor
// touches arrives through OffboardOps, which is what makes the tests above real tests rather
// than assertions about mocks.
import { OFFBOARD_STEP_ORDER, type OffboardPlan, type OffboardStepKey } from './planner.js';

export interface OffboardOps {
  blockSignin(userId: string): Promise<void>;
  revokeSessions(userId: string): Promise<void>;
  rename(userId: string, displayName: string): Promise<void>;
  removeLicenses(userId: string, skuIds: string[]): Promise<void>;
  removeFromGroups(userId: string, groupIds: string[]): Promise<void>;
  recordStep(key: string, status: 'succeeded' | 'failed' | 'awaiting_manual', detail: Record<string, unknown>): Promise<void>;
}

export interface OffboardOutcome { key: string; status: string; error?: string }

/** Steps that make the account safe. They destroy no data, so they run even on plan drift. */
const SECURITY_STEPS: OffboardStepKey[] = ['block_signin', 'revoke_sessions'];

export async function executeOffboardPlan(
  plan: OffboardPlan,
  userId: string,
  ops: OffboardOps,
  opts: { onlySecuritySteps?: boolean } = {},
): Promise<OffboardOutcome[]> {
  if (plan.blockers.length > 0) {
    throw new Error(`refusing to execute: plan carries ${plan.blockers.length} blocker(s)`);
  }
  // Trust nothing about step order, even from our own planner: this is the constraint that
  // protects the mailbox, and it is cheap to re-verify.
  const got = plan.steps.map((s) => s.key);
  const expected = OFFBOARD_STEP_ORDER.filter((k) => got.includes(k));
  if (got.join(',') !== expected.join(',')) {
    throw new Error(`refusing to execute: steps are out of order (${got.join(' -> ')})`);
  }

  const outcomes: OffboardOutcome[] = [];
  for (const step of plan.steps) {
    if (opts.onlySecuritySteps && !SECURITY_STEPS.includes(step.key)) {
      outcomes.push({ key: step.key, status: 'skipped' });
      continue;
    }
    // A manual step stops the run here. Everything after it depends on it having happened —
    // removing licenses first would destroy the mailbox the conversion exists to preserve.
    if (step.manual) {
      await ops.recordStep(step.key, 'awaiting_manual', step.detail);
      outcomes.push({ key: step.key, status: 'awaiting_manual' });
      break;
    }
    try {
      switch (step.key) {
        case 'block_signin': await ops.blockSignin(userId); break;
        case 'revoke_sessions': await ops.revokeSessions(userId); break;
        case 'rename_account': await ops.rename(userId, plan.inactiveName); break;
        case 'remove_licenses': await ops.removeLicenses(userId, (step.detail.skuIds as string[]) ?? []); break;
        case 'remove_groups_dls_roles': await ops.removeFromGroups(userId, (step.detail.groupIds as string[]) ?? []); break;
      }
      await ops.recordStep(step.key, 'succeeded', step.detail);
      outcomes.push({ key: step.key, status: 'succeeded' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'step failed';
      await ops.recordStep(step.key, 'failed', { ...step.detail, error: message });
      outcomes.push({ key: step.key, status: 'failed', error: message });
      break; // stop on first failure; later steps assume earlier ones happened
    }
  }
  return outcomes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/offboarding-executor.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/offboarding/executor.ts apps/api/test/offboarding-executor.test.ts
git commit -m "feat(offboarding): executor halting at the manual mailbox step"
```

---

### Task 7: Service layer — preview, schedule, execute

**Files:**
- Create: `apps/api/src/modules/offboarding/index.ts`
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/offboarding-service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–6, plus `provisioning.isEnabled()`.
- Produces:
```typescript
export async function preview(actor: Principal, ticketId: string): Promise<OffboardPlan & { fingerprint: string }>;
export async function schedule(actor: Principal, ticketId: string, fingerprint: string, scheduledFor: string): Promise<{ runId: string; status: string; scheduledFor: string }>;
export async function listRuns(actor: Principal, ticketId: string): Promise<unknown[]>;
```
Routes: `POST /api/v1/tickets/:id/offboarding/preview`, `POST /api/v1/tickets/:id/offboarding/schedule`, `GET /api/v1/tickets/:id/offboarding`.

- [ ] **Step 1: Write the failing tests**

Model the mocked-module harness on `apps/api/test/provisioning-service-flow.test.ts` — read that file first; it mocks the DB pool, config, Graph runtime, PDP and audit with recorders via `vi.hoisted`. Reuse that structure exactly rather than inventing a new one.

```typescript
describe('offboarding service', () => {
  it('refuses when provisioning config is disabled, before any I/O', async () => {
    h.config.provisioning.enabled = false;
    await expect(offboarding.preview(actor, TICKET)).rejects.toThrow(/not enabled/);
    expect(h.withSystemContext).not.toHaveBeenCalled();
  });

  it('authorizes against the TICKET organization, never a caller-supplied one', async () => {
    await offboarding.preview(actor, TICKET);
    expect(h.authorize).toHaveBeenCalledWith(actor, expect.any(String), { organizationId: TICKET_ORG });
  });

  it('refuses to schedule with a fingerprint that no longer matches the rebuilt plan', async () => {
    await expect(offboarding.schedule(actor, TICKET, 'stale-fp', '2026-09-05T21:00:00Z'))
      .rejects.toThrow(/changed since/i);
  });

  it('refuses a scheduled_for in the past rather than firing immediately', async () => {
    const fp = (await offboarding.preview(actor, TICKET)).fingerprint;
    await expect(offboarding.schedule(actor, TICKET, fp, '2020-01-01T00:00:00Z'))
      .rejects.toThrow(/in the past/i);
  });

  it('stores the run as scheduled with kind=offboarding', async () => {
    const fp = (await offboarding.preview(actor, TICKET)).fingerprint;
    await offboarding.schedule(actor, TICKET, fp, '2099-01-01T00:00:00Z');
    const insert = h.queries.find((q) => /INSERT INTO provisioning_runs/.test(q.text));
    expect(insert.params).toContain('offboarding');
    expect(insert.params).toContain('scheduled');
  });

  it('supplies the organization on the run insert (RLS is not inherited)', async () => {
    const fp = (await offboarding.preview(actor, TICKET)).fingerprint;
    await offboarding.schedule(actor, TICKET, fp, '2099-01-01T00:00:00Z');
    const insert = h.queries.find((q) => /INSERT INTO provisioning_runs/.test(q.text));
    expect(insert.params).toContain(TICKET_ORG);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/offboarding-service.test.ts`
Expected: FAIL — cannot find module `offboarding/index.js`.

- [ ] **Step 3: Implement the service**

Read `apps/api/src/modules/provisioning/index.ts` first and mirror its structure. The shape,
with the guard rails each test above pins:

```typescript
import { isEnabled } from '../provisioning/index.js';

function requireEnabled(): void {
  // ONE flag for both directions — a separate offboarding flag would let the destructive half
  // be switched on while the tenant config it depends on is absent.
  if (!isEnabled()) throw Errors.badRequest('provisioning is not enabled on this deployment');
}

/** THE ONLY planning path. preview and schedule both come through here — see the spec. */
async function buildPlan(ticketId: string): Promise<OffboardPlan> {
  const state = await readOffboardTenantState(ticketId);
  return planOffboard(state);
}

export async function preview(actor: Principal, ticketId: string) {
  requireEnabled();                              // before ANY I/O
  const ticket = await loadTicket(ticketId);
  authorize(actor, 'provisioning.execute', { organizationId: ticket.organization_id });
  const plan = await buildPlan(ticketId);
  return { ...plan, fingerprint: offboardFingerprint(plan) };
}

export async function schedule(
  actor: Principal, ticketId: string, fingerprint: string, scheduledFor: string,
) {
  requireEnabled();
  const ticket = await loadTicket(ticketId);
  authorize(actor, 'provisioning.execute', { organizationId: ticket.organization_id });

  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) throw Errors.badRequest('scheduled_for is not a valid instant');
  // Arming a run for a moment that has already passed would fire it on the next sweep, which is
  // not what "schedule" means and not what the approver read.
  if (when.getTime() <= Date.now()) throw Errors.badRequest('scheduled_for is in the past');

  const plan = await buildPlan(ticketId);
  if (plan.blockers.length > 0) {
    throw Errors.badRequest(`plan carries ${plan.blockers.length} blocker(s); refusing to schedule`);
  }
  if (offboardFingerprint(plan) !== fingerprint) {
    throw Errors.preconditionFailed(
      'The plan changed since you previewed it, so nothing was scheduled. Preview again and review the new plan.',
    );
  }

  const runId = await withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO provisioning_runs
         (ticket_id, organization_id, kind, status, scheduled_for, plan, started_by)
       VALUES ($1,$2,'offboarding','scheduled',$3,$4,$5)
       RETURNING id`,
      [ticketId, ticket.organization_id, when.toISOString(),
       JSON.stringify({ ...plan, fingerprint }), actor.id],
    );
    return rows[0].id as string;
  });

  await audit(actor, {
    action: 'offboarding.schedule', organizationId: ticket.organization_id,
    resourceType: 'ticket', resourceId: ticketId, detail: { runId, scheduledFor: when.toISOString() },
  });
  return { runId, status: 'scheduled', scheduledFor: when.toISOString() };
}
```

Also export `readOffboardTenantState(ticketId)` (reads the ticket answers plus `findUserByUpn`,
`directoryRoleCount`, `userLicenseSkuIds`, `userGroupIds`, `mailboxType`) and
`buildOffboardOps(runId, organizationId)` (binds the Task 5 Graph ops plus a `recordStep` that
INSERTs into `provisioning_steps` **with `organization_id`**). Task 8 consumes both.

- [ ] **Step 4: Add the routes**

In `apps/api/src/http/routes.ts`, beside the provisioning routes:

```typescript
  // ---------------- Entra account offboarding ----------------
  app.post('/api/v1/tickets/:id/offboarding/preview', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await offboarding.preview(p, id) };
  });

  app.post('/api/v1/tickets/:id/offboarding/schedule', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ fingerprint: z.string(), scheduledFor: z.string().datetime() }).parse(req.body ?? {});
    return { data: await offboarding.schedule(p, id, body.fingerprint, body.scheduledFor) };
  });

  app.get('/api/v1/tickets/:id/offboarding', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await offboarding.listRuns(p, id), offboardingEnabled: provisioning.isEnabled() };
  });
```

Add `import * as offboarding from '../modules/offboarding/index.js';` beside the provisioning import.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd apps/api && npx vitest run test/offboarding-service.test.ts && npx tsc --noEmit
```
Expected: PASS, and `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/offboarding/index.ts apps/api/src/http/routes.ts apps/api/test/offboarding-service.test.ts
git commit -m "feat(offboarding): service layer with one planning path and scheduling"
```

---

### Task 8: The scheduler sweeper, with the drift inversion

**Files:**
- Create: `apps/api/src/jobs/offboarding-sweeper.ts`
- Modify: `apps/api/src/server.ts` (register the interval beside the existing jobs)
- Test: `apps/api/test/offboarding-sweeper.test.ts`

**Interfaces:**
- Consumes: `executeOffboardPlan`, `planOffboard`, `offboardFingerprint`.
- Produces: `export async function sweepDueOffboardings(now?: Date): Promise<{ claimed: number; executed: number; needsReview: number }>`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('offboarding sweeper', () => {
  it('claims due runs with SKIP LOCKED so two sweepers cannot double-execute', async () => {
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    const claim = h.queries.find((q) => /UPDATE provisioning_runs/.test(q.text) && /scheduled/.test(q.text));
    expect(claim.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('does not claim a run whose scheduled_for is still in the future', async () => {
    h.setDbRows(() => []);
    const out = await sweepDueOffboardings(new Date('2026-09-01T00:00:00Z'));
    expect(out.executed).toBe(0);
  });

  // THE INVERSION. Onboarding refuses on drift; offboarding must still disable the account.
  it('on fingerprint drift still blocks sign-in and revokes sessions', async () => {
    driftTheStoredPlan();
    await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.blockSignin).toHaveBeenCalled();
    expect(h.ops.revokeSessions).toHaveBeenCalled();
  });

  it('on fingerprint drift halts the data-affecting steps and flags needs_review', async () => {
    driftTheStoredPlan();
    const out = await sweepDueOffboardings(new Date('2026-09-05T21:00:00Z'));
    expect(h.ops.removeLicenses).not.toHaveBeenCalled();
    expect(h.ops.rename).not.toHaveBeenCalled();
    expect(out.needsReview).toBe(1);
    const upd = h.queries.find((q) => /needs_review/.test(q.text));
    expect(upd).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/offboarding-sweeper.test.ts`
Expected: FAIL — cannot find module `jobs/offboarding-sweeper.js`.

- [ ] **Step 3: Implement**

```typescript
// Fires approved offboarding plans at HR's instant. Shaped like jobs/cloudpc-poller.ts.
//
// THE INVERSION, and it is deliberate: the provisioning engine refuses to execute when the
// rebuilt plan no longer matches the approved fingerprint, because creating the wrong account is
// worse than creating nothing. Offboarding is the opposite — FAILING TO DISABLE A TERMINATED
// EMPLOYEE IS THE DANGEROUS OUTCOME. So on drift we still block sign-in and revoke sessions
// (security-critical, destroys no data) and halt everything that touches licences, groups or the
// mailbox for a human to look at. Do not "fix" this into consistency with provisioning.
import { withSystemContext } from '../db/pool.js';
import { logger } from '../logger.js';
import { planOffboard, offboardFingerprint } from '../modules/offboarding/planner.js';
import { executeOffboardPlan } from '../modules/offboarding/executor.js';
import { buildOffboardOps, readOffboardTenantState } from '../modules/offboarding/index.js';

export async function sweepDueOffboardings(now: Date = new Date()) {
  let claimed = 0; let executed = 0; let needsReview = 0;

  const due = await withSystemContext(async (sql) => {
    // SKIP LOCKED is what makes two sweepers (or a rolling deploy running both the old and new
    // container for a moment) safe: a row already claimed by another transaction is passed over
    // rather than waited on, so a termination is never executed twice.
    const { rows } = await sql.query(
      `UPDATE provisioning_runs SET status = 'running', started_at = now()
        WHERE id IN (
          SELECT id FROM provisioning_runs
           WHERE kind = 'offboarding' AND status = 'scheduled' AND scheduled_for <= $1
           ORDER BY scheduled_for
           FOR UPDATE SKIP LOCKED
           LIMIT 25
        )
        RETURNING id, ticket_id, organization_id, plan`,
      [now.toISOString()],
    );
    return rows as Array<{ id: string; ticket_id: string; organization_id: string; plan: any }>;
  });
  claimed = due.length;

  for (const run of due) {
    try {
      const state = await readOffboardTenantState(run.ticket_id);
      const fresh = planOffboard(state);
      const drifted = offboardFingerprint(fresh) !== run.plan.fingerprint;

      const ops = buildOffboardOps(run.id, run.organization_id);
      const outcomes = await executeOffboardPlan(
        fresh, state.user!.id, ops, { onlySecuritySteps: drifted },
      );

      let status: string;
      if (drifted) {
        status = 'needs_review';
        needsReview += 1;
        logger.warn(
          { runId: run.id, ticketId: run.ticket_id },
          'offboarding plan drifted since approval; blocked sign-in and revoked sessions, halted the rest',
        );
      } else if (outcomes.some((o) => o.status === 'failed')) {
        status = 'failed';
      } else if (outcomes.some((o) => o.status === 'awaiting_manual')) {
        status = 'needs_review';
        needsReview += 1;
      } else {
        status = 'succeeded';
        executed += 1;
      }

      await withSystemContext(async (sql) => {
        await sql.query(
          `UPDATE provisioning_runs
              SET status = $2, finished_at = now(), error = $3
            WHERE id = $1 AND organization_id = $4`,
          [run.id, status, drifted ? 'plan changed since approval; data-affecting steps halted' : null, run.organization_id],
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sweep failed';
      logger.error({ err, runId: run.id }, 'offboarding sweep failed');
      await withSystemContext(async (sql) => {
        await sql.query(
          `UPDATE provisioning_runs SET status = 'failed', finished_at = now(), error = $2
            WHERE id = $1 AND organization_id = $3`,
          [run.id, message, run.organization_id],
        );
      });
    }
  }
  return { claimed, executed, needsReview };
}
```

`readOffboardTenantState(ticketId)` and `buildOffboardOps(runId, orgId)` are exported from the
Task 7 service — add them there if Task 7 did not already, keeping ALL Graph and DB access in the
service so the executor stays pure.

- [ ] **Step 4: Register the job**

In `apps/api/src/server.ts`, beside the existing job registrations, add an interval calling `sweepDueOffboardings()`. Match the surrounding pattern for interval length and error handling — a throw inside a job must not take the process down.

- [ ] **Step 5: Run tests and the full suite**

```bash
cd apps/api && npx vitest run test/offboarding-sweeper.test.ts && npx vitest run && npx tsc --noEmit
```
Expected: all pass, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/offboarding-sweeper.ts apps/api/src/server.ts apps/api/test/offboarding-sweeper.test.ts
git commit -m "feat(offboarding): scheduled sweeper that still disables on plan drift"
```

---

### Task 9: Intake form — a disable instant, not a date

**Files:**
- Create: `apps/api/src/db/migrations/0065_offboarding_disable_instant.sql`
- Modify: `apps/api/src/db/seed.ts` (the `catalogFormLinks` list — verify `user.offboarding` is present)
- Test: `apps/api/test/integration/offboarding-form.int.test.ts`

**Interfaces:**
- Produces: `m365_offboard.disable_effective` becomes a `datetime` field, plus a `disable_timezone` select.

- [ ] **Step 1: Write the failing test**

```typescript
describeDb('offboarding intake captures an instant', () => {
  it('asks for a disable time and timezone, not just a date', async () => {
    const fields = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT ff.key, ff.data_type FROM form_fields ff
           JOIN request_forms rf ON rf.id = ff.form_id
          WHERE rf.key = 'm365_offboard' AND ff.key IN ('disable_effective','disable_timezone')
          ORDER BY ff.key`,
      )).rows,
    );
    expect(fields).toEqual([
      { key: 'disable_effective', data_type: 'datetime' },
      { key: 'disable_timezone', data_type: 'select' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/offboarding-form.int.test.ts`
Expected: FAIL — `disable_effective` is `date` and `disable_timezone` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- "Block them at 5pm Friday" cannot be expressed as a bare date, and the sweeper fires on an
-- instant. Widen the field and ask for the zone explicitly rather than guessing UTC.
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key = 'm365_offboard' AND organization_id IS NULL;
  IF f IS NULL THEN RETURN; END IF;

  UPDATE form_fields SET data_type = 'datetime', label = 'Disable effective (date and time)'
   WHERE form_id = f AND key = 'disable_effective';

  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to)
  VALUES (f, 'disable_timezone', 'Timezone for the disable time', 'select', true,
          '["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","UTC"]',
          (SELECT coalesce(max(position), 0) + 1 FROM form_fields WHERE form_id = f), NULL)
  ON CONFLICT (form_id, key) DO UPDATE
    SET data_type = EXCLUDED.data_type, options = EXCLUDED.options, required = EXCLUDED.required;
END $$;
```

- [ ] **Step 4: Verify the field type is supported**

Run: `grep -rn "'datetime'" apps/api/src/modules/forms.ts | head`
If `datetime` is not an accepted `data_type` in the form validator, add it there following the existing `date` branch — a field type the validator rejects will fail every submission.

- [ ] **Step 5: Apply and verify**

```bash
cd apps/api && npx tsx --env-file ../../.env src/db/migrate.ts
npx vitest run test/integration/offboarding-form.int.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/migrations/0065_offboarding_disable_instant.sql apps/api/test/integration/offboarding-form.int.test.ts
git commit -m "feat(offboarding): intake captures a disable instant with an explicit timezone"
```

---

### Task 10: The ticket panel

**Files:**
- Create: `apps/web/components/offboarding-panel.tsx`
- Modify: `apps/web/app/(app)/tickets/[id]/page.tsx`
- Test: `apps/web/test/offboarding-panel.test.tsx`

**Interfaces:**
- Consumes: the Task 7 routes.
- Produces: `export function OffboardingPanel({ ticketId, canOffboard }: { ticketId: string; canOffboard: boolean })`

- [ ] **Step 1: Write the failing tests**

Model on `apps/web/test/provisioning-panel.test.tsx` — read it first; it mocks `@/lib/api` and drives real clicks.

```typescript
describe('OffboardingPanel', () => {
  it('says the feature is not configured rather than offering a dead button', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: false });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    expect(await screen.findByText(/not configured on this deployment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument();
  });

  it('unwraps the { data: Plan } envelope and renders the steps', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: {
      upn: 'jane.doe@sbsfederal.com', currentDisplayName: 'Jane Doe',
      inactiveName: 'ZZ_Inactive_Doe_Jane_2026-09-02', privileged: false,
      steps: [{ key: 'block_signin', label: 'Block sign-in', manual: false, detail: {} }],
      blockers: [], fingerprint: 'fp-1',
    }});
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText('Block sign-in')).toBeInTheDocument();
    expect(screen.getByText(/ZZ_Inactive_Doe_Jane_2026-09-02/)).toBeInTheDocument();
  });

  it('disables Schedule while the plan carries a blocker', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: {
      upn: 'x@y.gov', currentDisplayName: 'X', inactiveName: 'ZZ_Inactive_X_Y_2026-09-02',
      privileged: false, steps: [], fingerprint: 'fp-2',
      blockers: [{ code: 'legal_hold', message: 'Legal hold is set.' }],
    }});
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/Legal hold is set\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /schedule/i })).toBeDisabled();
  });

  it('marks the mailbox conversion as a manual step the tech must perform', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: {
      upn: 'x@y.gov', currentDisplayName: 'X', inactiveName: 'ZZ_Inactive_X_Y_2026-09-02',
      privileged: false, blockers: [], fingerprint: 'fp-3',
      steps: [{ key: 'convert_shared_mailbox', label: 'Convert mailbox to shared', manual: true, detail: {} }],
    }});
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/manual/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run test/offboarding-panel.test.tsx`
Expected: FAIL — cannot find `@/components/offboarding-panel`.

- [ ] **Step 3: Implement the panel**

Follow `apps/web/components/provisioning-panel.tsx` closely — same envelope handling (`api.post<{ data: Plan }>`, then `res.data`), same feature-off notice using `offboardingEnabled === false`, same blocker rendering with `aria-describedby`. Differences: a datetime input feeding `scheduledFor`, a "Schedule" button in place of "Provision", and manual steps rendered with a visible `manual` marker.

- [ ] **Step 4: Mount it on the ticket page**

In `apps/web/app/(app)/tickets/[id]/page.tsx`, beside the ProvisioningPanel mount, render `<OffboardingPanel ticketId={id} canOffboard={can('provisioning.execute')} />` gated on the ticket's category being `user.offboarding`.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
```
Expected: all pass, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/offboarding-panel.tsx "apps/web/app/(app)/tickets/[id]/page.tsx" apps/web/test/offboarding-panel.test.tsx
git commit -m "feat(offboarding): ticket panel for preview and scheduling"
```

---

## Scope note: fulfillment-time prompts are NOT in this plan

The spec's "Detection vs prompts" section splits prompts into intake-time (HR/manager) and
fulfillment-time (the tech). **Only the intake half is built here** — Task 9 widens the disable
instant, and `legal_hold` / `data_disposition` / `forward_to` already exist on the
`m365_offboard` form.

The fulfillment-time prompts — partner/customer equipment, badge, security token, Nextiva/VOIP,
VPN, shipping label — are deliberately deferred, because every one of them is about a physical
asset or an external system and belongs with **phase 3 (CMDB asset returns)** and **phase 4
(partner notifications)**. Building half of them here would mean a second prompt mechanism to
reconcile later.

One consequence worth stating: the spec's **PII routing requirement has no task in this plan**,
because the only phase-1 answer that could carry PII is a shipping address, and shipping labels
are phase 3. When phase 3 adds those prompts it MUST route address and personal-contact answers
to `ticket_sensitive_fields`, exactly as the onboarding intake does. That requirement travels
with phase 3, not with this plan.

## Final verification

- [ ] `cd apps/api && npx vitest run && npx tsc --noEmit`
- [ ] `cd apps/web && npx vitest run && npx tsc --noEmit`
- [ ] Rebuild from scratch and confirm the whole suite passes on a fresh database — the seed/migration ordering bug fixed in `aa6b2c0` only reproduced this way:

```bash
docker exec nexus-db psql -U nexus -d postgres -c "DROP DATABASE IF EXISTS nexus_verify;"
docker exec nexus-db psql -U nexus -d postgres -c "CREATE DATABASE nexus_verify OWNER nexus;"
cd apps/api
export DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus_verify
export APP_DATABASE_URL=postgres://nexus_app:nexus_app@localhost:5544/nexus_verify
npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && npx vitest run
docker exec nexus-db psql -U nexus -d postgres -c "DROP DATABASE IF EXISTS nexus_verify;"
```

- [ ] Confirm the feature is dark: with `M365_PROV_ENABLED` unset, `POST /tickets/:id/offboarding/preview` returns 400 and the panel shows the not-configured notice.

## Deployment note

`anchor-api` runs with `RUN_MIGRATIONS_ON_BOOT=true`, so `scripts/deploy-api.sh` applies migrations `0064` and `0065` on container restart. Both are additive — a new column with a default, a widened CHECK constraint, and a form-field type change. No permission or data destruction, unlike the CAB migrations. **Seed does not run on deploy**, so if `user.offboarding` needs its form link in prod, run the seed separately.

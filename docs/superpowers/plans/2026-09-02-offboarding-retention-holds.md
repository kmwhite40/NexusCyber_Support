# Offboarding Retention Holds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the runbook's 1-year / 7-year retention obligation when an account is offboarded, then notice when a retained account disappears early or reaches its date.

**Architecture:** A `retention_holds` table with its own lifecycle, written when an offboarding run succeeds, swept daily against Graph. Detection, not enforcement — Nexus cannot delete Entra accounts and cannot stop the Azure portal. Pure classification and date logic; a sweeper with injected ops, mirroring the phase-1 executor.

**Tech Stack:** TypeScript, Fastify, Postgres (RLS), Microsoft Graph (GCC High), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-offboarding-retention-holds-design.md` — read it before Task 1.

## Global Constraints

- **A hold must not depend on a foreign key.** Identity (`upn`, `entra_object_id`, `display_name_at_offboard`) is denormalized onto the row; every FK is `ON DELETE SET NULL`, never cascade.
- **Privileged means ANY evidence of privilege ever** — Entra directory roles at offboarding, OR a privileged Nexus role, OR any row in `elevation_grants` **including expired, revoked and break-glass**. Never filter to active grants.
- **Nothing is ever deleted automatically.** Expiry raises a ticket; a human disposes.
- A Graph error leaves the hold `active` and does **NOT** update `last_checked_at`.
- Every DB write supplies `organization_id` explicitly — RLS is not inherited through a foreign key.
- Retention classes: `standard` = 1 year, `privileged` = 7 years, computed from run completion.
- New catalog items must be DUAL-WRITTEN: seed.ts (fresh databases) **and** a migration (existing ones). See `docs/superpowers/specs` history and `test/integration/catalog-form-links.int.test.ts` — migrate runs before seed, so a migration alone silently no-ops on a fresh install and seed alone never reaches production.

---

### Task 1: Schema and the review catalog item

**Files:**
- Create: `apps/api/src/db/migrations/0069_retention_holds.sql`
- Modify: `apps/api/src/db/seed.ts` (catalog array + `catalogFormLinks` if a form is added later)
- Test: `apps/api/test/integration/retention-holds-schema.int.test.ts`

**Interfaces:**
- Produces: table `retention_holds`; catalog item `security.retention_review`.

- [ ] **Step 1: Write the failing test**

```typescript
import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

describeDb('retention_holds schema', () => {
  it('carries the denormalized identity a hold needs to outlive its ticket', async () => {
    const cols = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'retention_holds' ORDER BY column_name`,
      )).rows.map((r: { column_name: string }) => r.column_name));
    for (const c of ['upn', 'entra_object_id', 'display_name_at_offboard',
      'retention_class', 'retain_until', 'state', 'last_checked_at',
      'classification_basis', 'organization_id', 'run_id', 'ticket_id']) {
      expect(cols).toContain(c);
    }
  });

  it('nulls its references instead of cascading — a tidied ticket must not erase an obligation', async () => {
    const rules = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT confdeltype FROM pg_constraint
          WHERE conrelid = 'retention_holds'::regclass AND contype = 'f'`,
      )).rows.map((r: { confdeltype: string }) => r.confdeltype));
    expect(rules.length).toBeGreaterThan(0);
    // 'n' = SET NULL. 'c' would be CASCADE, which is the bug this test exists to prevent.
    expect(rules.every((r: string) => r === 'n')).toBe(true);
  });

  it('has the retention review catalog item', async () => {
    const key = await withSystemContext(async (sql) =>
      (await sql.query("SELECT key FROM service_catalog_items WHERE key='security.retention_review'")).rows[0]?.key);
    expect(key).toBe('security.retention_review');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker compose up -d db
cd apps/api && npx tsx --env-file ../../.env src/db/migrate.ts && npx tsx --env-file ../../.env src/db/seed.ts
npx vitest run test/integration/retention-holds-schema.int.test.ts
```
Expected: FAIL — relation `retention_holds` does not exist.

The dev DB is on host port **5544**, and without `--env-file ../../.env` these commands hit the wrong Postgres.

- [ ] **Step 3: Write the migration**

```sql
-- Retention holds: the runbook's 1-year / 7-year obligation, recorded so it can be checked.
--
-- A hold OUTLIVES its ticket and its run — up to seven years. It therefore denormalizes the
-- account's identity and nulls its references rather than cascading: tidying a ticket must not
-- destroy the record of an obligation with six years left, because the absence would look
-- exactly like compliance.
CREATE TABLE IF NOT EXISTS retention_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),

  -- Denormalized on purpose. A hold must say WHICH account without joining to anything.
  upn text NOT NULL,
  entra_object_id text NOT NULL,
  display_name_at_offboard text,

  retention_class text NOT NULL CHECK (retention_class IN ('standard','privileged')),
  -- WHY it is privileged: which directory roles, which Nexus roles, which elevation grants.
  -- An auditor asking "why seven years?" gets the answer from the row.
  classification_basis jsonb NOT NULL DEFAULT '{}'::jsonb,

  offboarded_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,

  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','breached','eligible','disposed')),
  -- Nullable so a sweeper that has stopped running is detectable.
  last_checked_at timestamptz,

  run_id uuid REFERENCES provisioning_runs(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The sweep predicate.
CREATE INDEX IF NOT EXISTS retention_holds_sweep_idx
  ON retention_holds (state, retain_until) WHERE state = 'active';

-- One account cannot accumulate duplicate live obligations.
CREATE UNIQUE INDEX IF NOT EXISTS retention_holds_account_live_idx
  ON retention_holds (entra_object_id) WHERE state <> 'disposed';

ALTER TABLE retention_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS retention_holds_isolation ON retention_holds;
CREATE POLICY retention_holds_isolation ON retention_holds FOR ALL
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

-- The catalog item the sweeper raises breach and disposal tickets against.
-- DUAL-WRITTEN with seed.ts: migrate runs BEFORE seed, so on a fresh database this INSERT
-- happens first and seed's upsert then finds it; on an existing database this is the only half
-- that runs. Neither alone is sufficient.
INSERT INTO service_catalog_items
  (key, name, category, description, ticket_type, owning_tier, requires_approval,
   default_priority, security_class, sla_response_min, sla_resolution_min, fulfillment_steps)
VALUES
  ('security.retention_review', 'Account retention review', 'Security',
   'Review a departed account whose retention obligation has expired, or which disappeared before it should have.',
   'service_request', 'Tier2', true, 'P3', 'standard', 480, 2880,
   '[{"key":"verify","label":"Verify the account state against the hold record","tier":"Tier2"},
     {"key":"decide","label":"Decide disposition and record the reason","tier":"Tier2"},
     {"key":"close","label":"Close the hold","tier":"Tier2"}]'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 4: Add the same catalog item to seed.ts**

In the `catalog` array in `apps/api/src/db/seed.ts`, add an entry matching the migration exactly:

```typescript
      {
        key: 'security.retention_review', name: 'Account retention review', category: 'Security',
        description: 'Review a departed account whose retention obligation has expired, or which disappeared before it should have.',
        ticket_type: 'service_request', owning_tier: 'Tier2', escalates_to: null,
        requires_approval: true, approver_hint: 'Security', default_priority: 'P3',
        security_class: 'standard', sla_response_min: 480, sla_resolution_min: 2880,
        steps: [
          step('verify', 'Verify the account state against the hold record', 'Tier2'),
          step('decide', 'Decide disposition and record the reason', 'Tier2'),
          step('close', 'Close the hold', 'Tier2'),
        ],
      },
```

This is the dual-write. A migration alone silently no-ops on a fresh install (migrate runs before the catalog rows exist... except here the migration CREATES the row, so it works both ways — but seed's upsert would otherwise overwrite nothing and the item would drift). Keeping both in step is what `test/integration/catalog-form-links.int.test.ts` and the seeded-KB discipline exist to enforce.

- [ ] **Step 5: Apply and verify**

```bash
cd apps/api && npx tsx --env-file ../../.env src/db/migrate.ts && npx tsx --env-file ../../.env src/db/seed.ts
npx vitest run test/integration/retention-holds-schema.int.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/migrations/0069_retention_holds.sql apps/api/src/db/seed.ts apps/api/test/integration/retention-holds-schema.int.test.ts
git commit -m "feat(retention): retention_holds table and the review catalog item"
```

---

### Task 2: Classification and the retention clock (pure)

**Files:**
- Create: `apps/api/src/modules/retention/classify.ts`
- Test: `apps/api/test/retention-classify.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface PrivilegeEvidence {
  directoryRoleCount: number;
  nexusPermissions: string[];
  elevationGrants: Array<{ status: string; break_glass: boolean; granted_permissions: string[] }>;
}
export interface Classification {
  retentionClass: 'standard' | 'privileged';
  basis: Record<string, unknown>;
}
export function classifyRetention(evidence: PrivilegeEvidence): Classification;
export function retainUntil(offboardedAt: Date, retentionClass: 'standard' | 'privileged'): Date;
export const PRIVILEGED_NEXUS_PERMISSIONS: string[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { classifyRetention, retainUntil } from '../src/modules/retention/classify.js';

const none = { directoryRoleCount: 0, nexusPermissions: [], elevationGrants: [] };

describe('classifyRetention', () => {
  it('is standard with no evidence of privilege', () => {
    expect(classifyRetention(none).retentionClass).toBe('standard');
  });

  it('is privileged on an Entra directory role', () => {
    expect(classifyRetention({ ...none, directoryRoleCount: 1 }).retentionClass).toBe('privileged');
  });

  it('is privileged on a privileged Nexus permission', () => {
    expect(classifyRetention({ ...none, nexusPermissions: ['cab.manage'] }).retentionClass).toBe('privileged');
  });

  it('is NOT privileged on an ordinary Nexus permission', () => {
    expect(classifyRetention({ ...none, nexusPermissions: ['ticket.create'] }).retentionClass).toBe('standard');
  });

  it('is privileged on an EXPIRED elevation grant', () => {
    // The grant's current status is irrelevant: if they ever held elevation, the privilege
    // existed. Filtering to active grants would silently downgrade exactly the people the
    // seven-year rule targets, and invisibly, since their access is already gone.
    expect(classifyRetention({
      ...none,
      elevationGrants: [{ status: 'expired', break_glass: false, granted_permissions: ['admin.superuser'] }],
    }).retentionClass).toBe('privileged');
  });

  it('is privileged on a REVOKED elevation grant', () => {
    expect(classifyRetention({
      ...none,
      elevationGrants: [{ status: 'revoked', break_glass: false, granted_permissions: ['x'] }],
    }).retentionClass).toBe('privileged');
  });

  it('records WHY it is privileged', () => {
    const c = classifyRetention({ directoryRoleCount: 2, nexusPermissions: ['cab.manage'], elevationGrants: [] });
    expect(c.basis).toMatchObject({ directoryRoleCount: 2, nexusPermissions: ['cab.manage'] });
  });

  it('records an empty basis for a standard account, not a missing one', () => {
    expect(classifyRetention(none).basis).toBeDefined();
  });
});

describe('retainUntil', () => {
  it('is one year out for a standard account', () => {
    expect(retainUntil(new Date('2026-09-02T12:00:00Z'), 'standard').toISOString())
      .toBe('2027-09-02T12:00:00.000Z');
  });

  it('is seven years out for a privileged account', () => {
    expect(retainUntil(new Date('2026-09-02T12:00:00Z'), 'privileged').toISOString())
      .toBe('2033-09-02T12:00:00.000Z');
  });

  it('handles a leap day without moving the anniversary into March', () => {
    // 2028 is a leap year; 2029 is not. Feb 29 + 1 year must land on Feb 28, not Mar 1 —
    // a date that silently drifts is a retention date nobody can reconcile against a record.
    expect(retainUntil(new Date('2028-02-29T00:00:00Z'), 'standard').toISOString().slice(0, 10))
      .toBe('2029-02-28');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/retention-classify.test.ts`
Expected: FAIL — cannot find module `retention/classify.js`.

- [ ] **Step 3: Implement**

```typescript
// Pure classification and date arithmetic for retention holds. No I/O — the service gathers the
// evidence and hands it in.
//
// Spec: docs/superpowers/specs/2026-09-02-offboarding-retention-holds-design.md

/** Nexus permissions that make an account privileged for retention purposes. */
export const PRIVILEGED_NEXUS_PERMISSIONS = [
  'admin.superuser', 'cab.manage', 'provisioning.execute', 'admin.users.manage',
];

export interface PrivilegeEvidence {
  directoryRoleCount: number;
  nexusPermissions: string[];
  elevationGrants: Array<{ status: string; break_glass: boolean; granted_permissions: string[] }>;
}

export interface Classification {
  retentionClass: 'standard' | 'privileged';
  basis: Record<string, unknown>;
}

/**
 * ANY evidence of privilege, EVER.
 *
 * Over-retention is the correct direction to err: keeping a record too long costs storage,
 * keeping it too short is a compliance failure that cannot be undone after the fact.
 *
 * Note what is deliberately NOT filtered: an elevation grant counts whatever its status. An
 * expired or revoked grant still means the privilege existed. Filtering to active grants would
 * look tidier and would silently downgrade exactly the people the seven-year rule targets —
 * invisibly, because by then their access has already been removed.
 */
export function classifyRetention(evidence: PrivilegeEvidence): Classification {
  const privilegedPerms = evidence.nexusPermissions
    .filter((p) => PRIVILEGED_NEXUS_PERMISSIONS.includes(p));

  const privileged = evidence.directoryRoleCount > 0
    || privilegedPerms.length > 0
    || evidence.elevationGrants.length > 0;

  return {
    retentionClass: privileged ? 'privileged' : 'standard',
    basis: {
      directoryRoleCount: evidence.directoryRoleCount,
      nexusPermissions: privilegedPerms,
      elevationGrants: evidence.elevationGrants.map((g) => ({
        status: g.status, breakGlass: g.break_glass, permissions: g.granted_permissions,
      })),
    },
  };
}

const YEARS: Record<'standard' | 'privileged', number> = { standard: 1, privileged: 7 };

/**
 * The retention date, measured from run completion — the account's disabled life begins when the
 * teardown actually ran, not on the last day worked.
 *
 * Clamps a leap day to the end of February rather than letting it roll into March: a retention
 * date that silently drifts is one nobody can reconcile against a record years later.
 */
export function retainUntil(offboardedAt: Date, retentionClass: 'standard' | 'privileged'): Date {
  const out = new Date(offboardedAt.getTime());
  const targetYear = out.getUTCFullYear() + YEARS[retentionClass];
  const month = out.getUTCMonth();
  const day = out.getUTCDate();
  const lastOfMonth = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  out.setUTCFullYear(targetYear, month, Math.min(day, lastOfMonth));
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/retention-classify.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/retention/classify.ts apps/api/test/retention-classify.test.ts
git commit -m "feat(retention): classification on any evidence of privilege ever, and the clock"
```

---

### Task 3: Create the hold when an offboarding run succeeds

**Files:**
- Create: `apps/api/src/modules/retention/index.ts`
- Modify: `apps/api/src/jobs/offboarding-sweeper.ts` (call it where a run finishes `succeeded`)
- Test: `apps/api/test/retention-service.test.ts`

**Interfaces:**
- Consumes: `classifyRetention`, `retainUntil` (Task 2).
- Produces:
```typescript
export async function recordHold(input: {
  organizationId: string; runId: string; ticketId: string;
  upn: string; entraObjectId: string; displayName: string;
  offboardedAt: Date; directoryRoleCount: number; departingUserId: string | null;
}): Promise<{ holdId: string | null; retentionClass: string }>;
```

- [ ] **Step 1: Write the failing tests**

Mock the DB pool with the `vi.hoisted` recorder harness used in `test/offboarding-service.test.ts` — read that file first and reuse its shape.

```typescript
describe('recordHold', () => {
  it('gathers Nexus permissions and elevation grants for the departing user', async () => {
    await recordHold(baseInput());
    expect(h.queries.some((q) => /FROM elevation_grants/.test(q.text))).toBe(true);
    expect(h.queries.some((q) => /role_permissions|permissions/.test(q.text))).toBe(true);
  });

  it('does NOT filter elevation grants by status', async () => {
    // An expired or revoked grant still means the privilege existed.
    await recordHold(baseInput());
    const grants = h.queries.find((q) => /FROM elevation_grants/.test(q.text))!;
    expect(grants.text).not.toMatch(/status\s*=/);
  });

  it('writes the denormalized identity, not just the references', async () => {
    await recordHold(baseInput());
    const ins = h.queries.find((q) => /INSERT INTO retention_holds/.test(q.text))!;
    expect(ins.params).toContain('jane.doe@sbsfederal.com');
    expect(ins.params).toContain('entra-obj-1');
  });

  it('supplies the organization explicitly — RLS is not inherited', async () => {
    await recordHold(baseInput());
    const ins = h.queries.find((q) => /INSERT INTO retention_holds/.test(q.text))!;
    expect(ins.params).toContain(ORG);
  });

  it('classifies a directory-role holder as privileged', async () => {
    const out = await recordHold({ ...baseInput(), directoryRoleCount: 2 });
    expect(out.retentionClass).toBe('privileged');
  });

  it('does not create a second live hold for the same account', async () => {
    // The unique index refuses it; the service must surface that as a no-op, not a crash.
    h.setDbRows((text: string) => (/INSERT INTO retention_holds/.test(text) ? [] : []));
    const out = await recordHold(baseInput());
    expect(out.holdId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/retention-service.test.ts`
Expected: FAIL — cannot find module `retention/index.js`.

- [ ] **Step 3: Implement the service**

```typescript
// Retention hold creation. All the I/O; classify.ts stays pure.
import { withSystemContext, type Sql } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { classifyRetention, retainUntil } from './classify.js';

export async function recordHold(input: {
  organizationId: string; runId: string; ticketId: string;
  upn: string; entraObjectId: string; displayName: string;
  offboardedAt: Date; directoryRoleCount: number; departingUserId: string | null;
}): Promise<{ holdId: string | null; retentionClass: string }> {
  const evidence = await withSystemContext(async (sql: Sql) => {
    if (!input.departingUserId) {
      return { directoryRoleCount: input.directoryRoleCount, nexusPermissions: [], elevationGrants: [] };
    }
    const { rows: perms } = await sql.query(
      `SELECT DISTINCT rp.permission_key AS key
         FROM role_assignments ra
         JOIN role_permissions rp ON rp.role_id = ra.role_id
        WHERE ra.user_id = $1`,
      [input.departingUserId],
    );
    // NO status filter, deliberately: an expired or revoked grant still means the privilege
    // existed, and that is what the seven-year rule is about.
    const { rows: grants } = await sql.query(
      'SELECT status, break_glass, granted_permissions FROM elevation_grants WHERE user_id = $1',
      [input.departingUserId],
    );
    return {
      directoryRoleCount: input.directoryRoleCount,
      nexusPermissions: perms.map((p: { key: string }) => p.key),
      elevationGrants: grants as any[],
    };
  });

  const { retentionClass, basis } = classifyRetention(evidence);
  const until = retainUntil(input.offboardedAt, retentionClass);

  const holdId = await withSystemContext(async (sql: Sql) => {
    // ON CONFLICT DO NOTHING against the live-account unique index: a second hold for one
    // account is a no-op, not a crash.
    const { rows } = await sql.query(
      `INSERT INTO retention_holds
         (organization_id, upn, entra_object_id, display_name_at_offboard,
          retention_class, classification_basis, offboarded_at, retain_until,
          run_id, ticket_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [input.organizationId, input.upn, input.entraObjectId, input.displayName,
        retentionClass, JSON.stringify(basis), input.offboardedAt.toISOString(),
        until.toISOString(), input.runId, input.ticketId],
    );
    return rows[0]?.id as string | undefined ?? null;
  });

  logger.info({ holdId, retentionClass, retainUntil: until.toISOString(), upn: input.upn },
    'retention hold recorded');
  return { holdId, retentionClass };
}
```

- [ ] **Step 4: Call it from the sweeper's success path**

In `apps/api/src/jobs/offboarding-sweeper.ts`, replace the `succeeded` branch:

```typescript
      } else {
        executed += 1;
        // Record the retention obligation BEFORE marking the run succeeded, but never let a
        // failure here fail the run: the teardown genuinely happened, and losing that fact
        // would be worse than losing the hold, which can be recreated from the run.
        try {
          await recordHold({
            organizationId: run.organization_id,
            runId: run.id,
            ticketId: run.ticket_id,
            upn: state.user.userPrincipalName,
            entraObjectId: state.user.id,
            displayName: state.user.displayName,
            offboardedAt: now,
            directoryRoleCount: state.directoryRoleCount,
            departingUserId: typeof state.answers.departing_user === 'string'
              ? state.answers.departing_user
              : null,
          });
        } catch (err) {
          logger.error({ err, runId: run.id }, 'offboarding succeeded but the retention hold was not recorded');
        }
        await finish(run, 'succeeded', null);
      }
```

Add `import { recordHold } from '../modules/retention/index.js';` at the top.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd apps/api && npx vitest run && npx tsc --noEmit
```
Expected: all pass, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/retention/index.ts apps/api/src/jobs/offboarding-sweeper.ts apps/api/test/retention-service.test.ts
git commit -m "feat(retention): record a hold when an offboarding run succeeds"
```

---

### Task 4: The sweep decision (pure)

**Files:**
- Create: `apps/api/src/modules/retention/sweep-decision.ts`
- Test: `apps/api/test/retention-sweep-decision.test.ts`

**Interfaces:**
- Produces:
```typescript
export type HoldOutcome =
  | { action: 'none' }
  | { action: 'touch' }
  | { action: 'breach' }
  | { action: 'eligible' }
  | { action: 'disposed' };
export function decideHold(
  hold: { retain_until: string | Date },   // pg returns timestamptz as Date
  accountPresent: boolean | null,          // null = could not check
  now: Date,
): HoldOutcome;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { decideHold } from '../src/modules/retention/sweep-decision.js';

const hold = { retain_until: '2027-09-02T00:00:00.000Z' };
const before = new Date('2027-01-01T00:00:00Z');
const after = new Date('2027-10-01T00:00:00Z');

describe('decideHold', () => {
  it('touches a present account inside its window', () => {
    expect(decideHold(hold, true, before)).toEqual({ action: 'touch' });
  });

  it('BREACHES when the account is gone before its date', () => {
    expect(decideHold(hold, false, before)).toEqual({ action: 'breach' });
  });

  it('is eligible when the date has passed and the account is still there', () => {
    expect(decideHold(hold, true, after)).toEqual({ action: 'eligible' });
  });

  it('is disposed when the account is gone after its date', () => {
    expect(decideHold(hold, false, after)).toEqual({ action: 'disposed' });
  });

  it('does NOTHING when the account could not be checked', () => {
    // A tenant outage must never read as "account confirmed present" — that is the one reading
    // that would let a real breach pass unnoticed. Not even last_checked_at may be stamped.
    expect(decideHold(hold, null, before)).toEqual({ action: 'none' });
    expect(decideHold(hold, null, after)).toEqual({ action: 'none' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/retention-sweep-decision.test.ts`
Expected: FAIL — cannot find module `retention/sweep-decision.js`.

- [ ] **Step 3: Implement**

```typescript
/**
 * What to do about one hold. Pure, so every branch is testable without a tenant.
 *
 * `accountPresent === null` means the check did not complete. It returns 'none' — NOT 'touch' —
 * because stamping last_checked_at on an unsuccessful check records a tenant outage as "account
 * confirmed present", which is precisely the reading that would let a real breach pass unnoticed.
 */
export type HoldOutcome =
  | { action: 'none' } | { action: 'touch' } | { action: 'breach' }
  | { action: 'eligible' } | { action: 'disposed' };

export function decideHold(
  hold: { retain_until: string | Date },
  accountPresent: boolean | null,
  now: Date,
): HoldOutcome {
  if (accountPresent === null) return { action: 'none' };
  const expired = now.getTime() >= new Date(hold.retain_until).getTime();
  if (accountPresent) return expired ? { action: 'eligible' } : { action: 'touch' };
  return expired ? { action: 'disposed' } : { action: 'breach' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/retention-sweep-decision.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/retention/sweep-decision.ts apps/api/test/retention-sweep-decision.test.ts
git commit -m "feat(retention): the pure sweep decision, including the un-checkable case"
```

---

### Task 5: The retention sweeper

**Files:**
- Create: `apps/api/src/jobs/retention-sweeper.ts`
- Modify: `apps/api/src/server.ts` (register the interval)
- Test: `apps/api/test/retention-sweeper.test.ts`

**Interfaces:**
- Consumes: `decideHold` (Task 4), `findUserById` (added below), the offboarding Graph runtime.
- Produces: `export async function sweepRetentionHolds(now?: Date): Promise<{ checked: number; breached: number; eligible: number; disposed: number; unchecked: number }>` and `export function startRetentionSweeper(intervalMs?: number): NodeJS.Timeout`

- [ ] **Step 1: Write the failing tests**

Define the harness helper the tests below use — the `vi.hoisted` recorder shape from
`test/offboarding-sweeper.test.ts`, plus:

```typescript
/** Arms the DB double with exactly one active hold, and the Graph double with its answer. */
function armHold(opts: { present: boolean | 'error'; retain_until: string }) {
  h.setDbRows((text: string) => {
    if (/FROM retention_holds/.test(text)) {
      return [{
        id: 'hold-1', organization_id: ORG, upn: 'jane.doe@sbsfederal.com',
        entra_object_id: 'entra-obj-1', display_name_at_offboard: 'Jane Doe',
        retention_class: 'standard', retain_until: opts.retain_until,
        offboarded_at: '2026-09-02T00:00:00.000Z',
      }];
    }
    if (/COALESCE\(MAX/.test(text)) return [{ n: 1 }];          // next ticket number
    if (/FROM organizations/.test(text)) return [{ name: 'SBS' }];
    return [];
  });
  h.graphGet.mockImplementation(async () => {
    if (opts.present === 'error') throw new Error('graph unreachable');
    if (opts.present === false) { const e: any = new Error('not found'); e.status = 404; throw e; }
    return { id: 'entra-obj-1' };
  });
}
```

```typescript
describe('sweepRetentionHolds', () => {
  it('raises a ticket naming the account when one vanished early', async () => {
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.breached).toBe(1);
    const ins = h.queries.find((q) => /INSERT INTO tickets/.test(q.text))!;
    expect(JSON.stringify(ins.params)).toContain('jane.doe@sbsfederal.com');
    const upd = h.queries.find((q) => /UPDATE retention_holds/.test(q.text) && /breached/.test(q.text));
    expect(upd).toBeTruthy();
  });

  it('raises a disposal ticket when the date has passed', async () => {
    armHold({ present: true, retain_until: '2020-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.eligible).toBe(1);
    expect(h.queries.some((q) => /INSERT INTO tickets/.test(q.text))).toBe(true);
  });

  it('does NOT stamp last_checked_at when the check failed', async () => {
    armHold({ present: 'error', retain_until: '2099-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.unchecked).toBe(1);
    expect(h.queries.some((q) => /last_checked_at/.test(q.text))).toBe(false);
  });

  it('reports how many holds it could not check, so a failing sweeper is visible', async () => {
    armHold({ present: 'error', retain_until: '2099-01-01T00:00:00Z' });
    const out = await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(out.unchecked).toBeGreaterThan(0);
  });

  it('never deletes anything', async () => {
    armHold({ present: true, retain_until: '2020-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    expect(h.queries.some((q) => /DELETE FROM/.test(q.text))).toBe(false);
  });

  it('does not raise a second ticket for a hold already breached', async () => {
    // Only 'active' holds are swept, so a breached hold is not revisited.
    armHold({ present: false, retain_until: '2099-01-01T00:00:00Z' });
    await sweepRetentionHolds(new Date('2026-09-05T00:00:00Z'));
    const sel = h.queries.find((q) => /FROM retention_holds/.test(q.text))!;
    expect(sel.text).toContain("state = 'active'");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/retention-sweeper.test.ts`
Expected: FAIL — cannot find module `jobs/retention-sweeper.js`.

- [ ] **Step 3: Add the Graph lookup by object id**

In `apps/api/src/integrations/m365/provisioning-graph.ts`:

```typescript
/**
 * Whether an account still exists, by object id. Returns null when the answer is UNKNOWN —
 * a throttle, an outage, a permissions problem. The retention sweeper must be able to tell
 * "confirmed gone" from "could not ask", because treating the second as the first would
 * manufacture a compliance breach, and treating it as "present" would hide a real one.
 */
export async function accountExists(g: GraphClient, objectId: string): Promise<boolean | null> {
  try {
    const res = await g.get(`/users/${objectId}?$select=id`);
    return Boolean(res?.id);
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) return false;
    return null;
  }
}
```

- [ ] **Step 4: Implement the sweeper**

```typescript
// Daily retention sweep. Detection, not enforcement: Nexus cannot delete Entra accounts and
// cannot stop the Azure portal, so this exists to NOTICE.
//
// NOTHING HERE DELETES ANYTHING. Expiry raises a ticket for a human. A cron job destroying
// seven-year federal records unattended is not supervisable, and the failure would surface years
// later via an auditor rather than via the system.
import { withSystemContext, type Sql } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getProvisioningGraph } from '../integrations/m365/provisioning-runtime.js';
import { accountExists } from '../integrations/m365/provisioning-graph.js';
import { nextTicketNumber } from '../modules/tickets.js';
import { decideHold } from '../modules/retention/sweep-decision.js';

export async function sweepRetentionHolds(now: Date = new Date()) {
  let checked = 0; let breached = 0; let eligible = 0; let disposed = 0; let unchecked = 0;

  const holds = await withSystemContext(async (sql: Sql) => {
    const { rows } = await sql.query(
      `SELECT id, organization_id, upn, entra_object_id, display_name_at_offboard,
              retention_class, retain_until, offboarded_at
         FROM retention_holds
        WHERE state = 'active'
        ORDER BY retain_until
        LIMIT 500`,
    );
    return rows as any[];
  });

  const g = holds.length > 0 ? await getProvisioningGraph() : null;

  for (const hold of holds) {
    const present = g ? await accountExists(g.graph, hold.entra_object_id) : null;
    const outcome = decideHold(hold, present, now);
    checked += 1;

    switch (outcome.action) {
      case 'none':
        // Deliberately not even a last_checked_at stamp — see decideHold.
        unchecked += 1;
        break;
      case 'touch':
        await setChecked(hold, now);
        break;
      case 'breach':
        breached += 1;
        await raiseTicket(hold, 'breach', now);
        await setState(hold, 'breached', now);
        logger.error({ holdId: hold.id, upn: hold.upn, retainUntil: hold.retain_until },
          'RETENTION BREACH: a retained account no longer exists in the tenant');
        break;
      case 'eligible':
        eligible += 1;
        await raiseTicket(hold, 'eligible', now);
        await setState(hold, 'eligible', now);
        break;
      case 'disposed':
        disposed += 1;
        await setState(hold, 'disposed', now);
        break;
    }
  }

  if (unchecked > 0) {
    // A retention system nobody notices has stopped is worse than none, because it is trusted.
    logger.warn({ unchecked, checked }, 'retention sweep could not check some holds');
  }
  return { checked, breached, eligible, disposed, unchecked };
}

async function setChecked(hold: any, now: Date): Promise<void> {
  await withSystemContext(async (sql: Sql) => {
    await sql.query(
      'UPDATE retention_holds SET last_checked_at = $2, updated_at = now() WHERE id = $1 AND organization_id = $3',
      [hold.id, now.toISOString(), hold.organization_id],
    );
  });
}

async function setState(hold: any, state: string, now: Date): Promise<void> {
  await withSystemContext(async (sql: Sql) => {
    await sql.query(
      `UPDATE retention_holds SET state = $2, last_checked_at = $3, updated_at = now()
        WHERE id = $1 AND organization_id = $4`,
      [hold.id, state, now.toISOString(), hold.organization_id],
    );
  });
}

/**
 * A ticket, not a notification: a notification is a thing to miss, a ticket is a thing to work.
 * Inserted directly rather than through createTicket() because a background job has no acting
 * principal — the same pattern as modules/posture.ts and integrations/m365/ingest.ts.
 */
async function raiseTicket(hold: any, kind: 'breach' | 'eligible', now: Date): Promise<void> {
  const subject = kind === 'breach'
    ? `Retention breach: ${hold.upn} was deleted before ${String(hold.retain_until).slice(0, 10)}`
    : `Retention expired: review and dispose ${hold.upn}`;
  const description = kind === 'breach'
    ? `The account ${hold.upn} (${hold.display_name_at_offboard ?? 'unknown name'}) was offboarded on `
      + `${String(hold.offboarded_at).slice(0, 10)} and classified ${hold.retention_class}, so it had to be `
      + `retained until ${String(hold.retain_until).slice(0, 10)}. It no longer exists in the tenant. `
      + `Determine who removed it and when, and record the outcome.`
    : `The account ${hold.upn} was offboarded on ${String(hold.offboarded_at).slice(0, 10)} and classified `
      + `${hold.retention_class}. Its retention obligation ended on ${String(hold.retain_until).slice(0, 10)}. `
      + `Review and decide disposition. Nothing has been deleted automatically.`;

  await withSystemContext(async (sql: Sql) => {
    const number = await nextTicketNumber(sql, hold.organization_id);
    await sql.query(
      `INSERT INTO tickets
         (organization_id, ticket_number, type, category, source_channel, subject, description,
          priority, status)
       VALUES ($1,$2,'service_request','security.retention_review','system',$3,$4,$5,'triage')`,
      [hold.organization_id, number, subject, description, kind === 'breach' ? 'P2' : 'P3'],
    );
  });
}

/** Daily. A one-to-seven-year window needs no finer resolution. */
export function startRetentionSweeper(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const out = await sweepRetentionHolds(new Date());
      if (out.checked > 0) logger.info(out, 'retention sweep completed');
    } catch (err) {
      logger.error({ err }, 'retention sweep tick failed');
    }
  };
  return setInterval(tick, intervalMs);
}
```

- [ ] **Step 5: Register the job**

In `apps/api/src/server.ts`, beside the offboarding sweeper registration, inside the
`config.provisioning.enabled` block:

```typescript
    // Retention holds outlive the offboarding feature flag by years, so this sweeps whenever
    // provisioning is configured at all — not only when offboarding is switched on. A hold
    // recorded while the feature was live must keep being checked after it is switched off.
    startRetentionSweeper();
    logger.info('Retention sweeper enabled');
```

- [ ] **Step 6: Run tests and typecheck**

```bash
cd apps/api && npx vitest run && npx tsc --noEmit
```
Expected: all pass, `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/retention-sweeper.ts apps/api/src/server.ts apps/api/src/integrations/m365/provisioning-graph.ts apps/api/test/retention-sweeper.test.ts
git commit -m "feat(retention): daily sweep that notices breaches and expiries"
```

---

## Final verification

- [ ] `cd apps/api && npx vitest run && npx tsc --noEmit`
- [ ] Rebuild from scratch and confirm the suite passes on a fresh database:

```bash
docker exec nexus-db psql -U nexus -d postgres -c "DROP DATABASE IF EXISTS nexus_verify;"
docker exec nexus-db psql -U nexus -d postgres -c "CREATE DATABASE nexus_verify OWNER nexus;"
cd apps/api
export DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus_verify
export APP_DATABASE_URL=postgres://nexus_app:nexus_app@localhost:5544/nexus_verify
npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && npx vitest run
docker exec nexus-db psql -U nexus -d postgres -c "DROP DATABASE IF EXISTS nexus_verify;"
```

- [ ] Confirm `security.retention_review` exists on BOTH a fresh database and one migrated from an
      existing state — that is the dual-write, and only the fresh rebuild proves half of it.
- [ ] Confirm no code path deletes an account or a hold: `grep -rn "DELETE FROM retention_holds" apps/api/src` returns nothing.

## Deployment note

`anchor-api` runs `RUN_MIGRATIONS_ON_BOOT=true`, so `scripts/deploy-api.sh` applies migration
`0069` on restart. It is additive: a new table, a new catalog row, no changes to existing data.

The sweeper starts whenever provisioning is configured, so on a deployment where
`M365_PROV_ENABLED` is unset it never runs and there are no holds to sweep. On a deployment where
provisioning IS enabled but offboarding is not, it runs and finds nothing — correct, and cheap.

## Out of scope

- **UI.** No panel or view for holds. The tickets the sweeper raises are the interface; a
  compliance view can come later if the ticket flow proves insufficient.
- **Backfill.** No production ticket has been through an offboarding run, so there is nothing to
  backfill.
- **Automatic deletion.** Deliberate. See the spec.

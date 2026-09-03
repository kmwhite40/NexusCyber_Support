# Nexus Tier 1 — Security & Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security & compliance MVP gaps in the Nexus platform — a compliance/evidence subsystem, SIEM export + audit-chain verification, JIT elevation & break-glass, and secure attachments — each shipped with tests.

**Architecture:** Each work package adds a numbered SQL migration (RLS-conformant), a typed module in `apps/api/src/modules/` following the existing `withOrgContext`/`audit()`/`publish()` conventions, Zod-validated routes in `apps/api/src/http/routes.ts` gated by the RBAC+ABAC PDP, seed permissions, unit tests for pure logic, and (where DB-backed) integration tests that auto-skip when no `DATABASE_URL` is configured. External touchpoints (SIEM sink, blob store, malware scanner) are TypeScript interfaces with mock implementations, swappable for real ones later.

**Tech Stack:** Fastify 4, node-postgres (`pg`) with Postgres Row-Level Security, Zod, Vitest, Next.js (App Router) + Tailwind, TypeScript (NodeNext, explicit `.js` import specifiers).

---

## Design notes & decisions (read first)

- **Migrations are per-package** here: `0005_compliance.sql`, `0006_elevation.sql`, `0007_attachments.sql`. The runner applies `migrations/*.sql` in lexicographic order and tracks them in `schema_migrations`.
- **Evidence is computed at read time**, not stored in a separate `evidence_items` table. The spec listed `evidence_items`; we deliberately compute control evidence on demand from the **immutable** sources (`audit_logs` hash-chain, `posture_findings`, `conmon_runs`). This is simpler and *more* tamper-evident than a writable evidence table. (If a stored evidence ledger is later required, it can be added without changing the API surface.)
- **`elevation_grants` has no RLS** and is accessed via `withSystemContext`, with authorization enforced in code — mirroring the existing `automation_rules` pattern (`0004`). `loadPrincipal` already runs in `withSystemContext`, so it can read active grants there to augment permissions.
- **RLS conventions** (from `0004_approvals_automation.sql`): tenant tables get `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`, `ENABLE ROW LEVEL SECURITY`, and a policy `USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))` with the identical `WITH CHECK`, then `GRANT SELECT, INSERT, UPDATE, DELETE ... TO nexus_app`.
- **Permission seeding:** add verbs to the `PERMISSIONS` array and to role `perms` in `apps/api/src/db/seed.ts`. `admin.superuser` already implies everything in the PDP.
- **Existing relevant permissions:** `posture.request_exception` and `posture.approve_exception` already exist in the seed — reuse them for WP1 exceptions.
- **Run all commands from the repo root** (`/Users/kevinwhite/Documents/NexusCyber_Support`) unless noted. API workspace tests run with `npm --workspace apps/api run test`.

---

## Task 0: DB-backed integration-test scaffolding (skip-if-no-DB)

Establishes the helper every integration test uses so local unit runs stay DB-free.

**Files:**
- Create: `apps/api/test/helpers/db.ts`
- Create: `apps/api/test/helpers/db.smoke.test.ts`

- [ ] **Step 1: Write the helper**

Create `apps/api/test/helpers/db.ts`:

```ts
// Shared helper for DB-backed integration tests. When DATABASE_URL is unset
// (the default for fast local unit runs and the existing CI unit job), the
// returned `describeDb` is `describe.skip`, so integration suites are skipped
// cleanly rather than failing.
import { describe } from 'vitest';

export const hasDb = !!process.env.DATABASE_URL;

/** Use in place of `describe` for suites that need a live Postgres. */
export const describeDb: typeof describe.skip = hasDb ? describe : describe.skip;
```

- [ ] **Step 2: Write a smoke test that proves skip-vs-run behavior**

Create `apps/api/test/helpers/db.smoke.test.ts`:

```ts
import { it, expect, describe } from 'vitest';
import { hasDb, describeDb } from './db.js';

describe('integration-test scaffolding', () => {
  it('exposes hasDb as a boolean', () => {
    expect(typeof hasDb).toBe('boolean');
  });
});

describeDb('a DB-backed suite (runs only when DATABASE_URL is set)', () => {
  it('runs when a database is configured', () => {
    expect(hasDb).toBe(true);
  });
});
```

- [ ] **Step 3: Run the API test suite to verify it passes (DB-free)**

Run: `npm --workspace apps/api run test`
Expected: PASS. The `describeDb(...)` block is skipped (no `DATABASE_URL`); the plain `describe` assertion passes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/helpers/db.ts apps/api/test/helpers/db.smoke.test.ts
git commit -m "test: add skip-if-no-DB integration-test scaffolding"
```

---

## WP1 — Compliance & evidence

### Task 1: Compliance & exceptions migration

**Files:**
- Create: `apps/api/src/db/migrations/0005_compliance.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/src/db/migrations/0005_compliance.sql`:

```sql
-- Compliance control catalog + control->evidence mappings (global config, org-NULL,
-- no RLS — read via the system context), plus posture exceptions (tenant, RLS).
-- Evidence itself is computed at read time from audit_logs / posture_findings /
-- conmon_runs; see docs/superpowers/plans/2026-06-11-nexus-tier1-security-compliance.md.

CREATE TABLE compliance_controls (
  control_id   text PRIMARY KEY,                 -- e.g. 'AC-2'
  framework    text NOT NULL,                    -- 'NIST-800-53' | 'NIST-800-171' | 'CMMC-L2'
  family       text NOT NULL,                    -- 'Access Control'
  title        text NOT NULL,
  description  text
);

-- Which runtime signal satisfies a control.
--   source = 'audit_action'   -> presence of audit_logs.action = source_key (recent)
--   source = 'posture_domain' -> no OPEN posture_findings in domain = source_key
--   source = 'conmon_check'   -> latest conmon_runs for check = source_key is 'pass'
CREATE TABLE control_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id  text NOT NULL REFERENCES compliance_controls(control_id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('audit_action','posture_domain','conmon_check')),
  source_key  text NOT NULL,
  UNIQUE (control_id, source, source_key)
);
CREATE INDEX ix_control_mappings_control ON control_mappings(control_id);

CREATE TABLE posture_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id           uuid NOT NULL REFERENCES posture_findings(id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES users(id),
  justification        text NOT NULL,
  compensating_control text,
  expires_at           timestamptz,
  status               text NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','approved','rejected','expired')),
  decided_by           uuid REFERENCES users(id),
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_posture_exceptions_finding ON posture_exceptions(finding_id);

ALTER TABLE posture_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY posture_exceptions_isolation ON posture_exceptions
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON posture_exceptions TO nexus_app;
GRANT SELECT ON compliance_controls, control_mappings TO nexus_app;
```

- [ ] **Step 2: Apply the migration (requires a local DB)**

Run: `npm run db:up && npm run db:migrate`
Expected: log line `apply 0005_compliance.sql` and `migrations complete`. (If no Docker/DB is available locally, this is verified in CI by Task 23; proceed — later pure-logic tests do not need the DB.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0005_compliance.sql
git commit -m "feat(db): compliance controls, mappings, and posture exceptions (0005)"
```

### Task 2: Seed compliance permissions + control catalog

**Files:**
- Modify: `apps/api/src/db/seed.ts` (PERMISSIONS array ~line 7-33; ROLES ~line 36-59; add a control-seed block before the closing of the `withSystemContext` callback, after the ConMon checks block ~line 442)

- [ ] **Step 1: Add permissions and grant them to roles**

In `apps/api/src/db/seed.ts`, add to the `PERMISSIONS` array (after the `['audit.read', 'audit'],` entry):

```ts
  ['compliance.read', 'compliance'],
  ['compliance.manage', 'compliance'],
```

Then grant them: in `ROLES`, append `'compliance.read'` and `'compliance.manage'` to `SecurityAnalyst.perms` and `ServiceDeskManager.perms`; append `'compliance.read'` to `OrgAdmin.perms` and `SecurityContact.perms`. For example `SecurityAnalyst` becomes:

```ts
  SecurityAnalyst: {
    plane: 'nexus',
    perms: ['ticket.create', 'ticket.read.all_assigned_customers', 'ticket.escalate', 'posture.read', 'posture.write', 'posture.finding.manage', 'posture.approve_exception', 'oncall.acknowledge', 'oncall.page', 'audit.read', 'compliance.read', 'compliance.manage'],
  },
```

(Apply the analogous append to the other three roles; `posture.approve_exception` is also added to `SecurityAnalyst` and `ServiceDeskManager` so Nexus agents can decide exceptions.)

- [ ] **Step 2: Seed a starter control catalog + mappings**

In `apps/api/src/db/seed.ts`, immediately after the ConMon `for (const [key, name, domain, cadence, refs, severity] of conmonChecks)` loop closes (~line 442), add:

```ts
    // ---- Compliance control catalog (starter NIST 800-53 subset) + evidence mappings ----
    const controls = [
      ['AC-2', 'NIST-800-53', 'Access Control', 'Account Management'],
      ['AC-6', 'NIST-800-53', 'Access Control', 'Least Privilege'],
      ['AU-6', 'NIST-800-53', 'Audit and Accountability', 'Audit Review, Analysis, and Reporting'],
      ['AU-12', 'NIST-800-53', 'Audit and Accountability', 'Audit Record Generation'],
      ['IA-2', 'NIST-800-53', 'Identification and Authentication', 'Identification and Authentication (Users)'],
      ['RA-5', 'NIST-800-53', 'Risk Assessment', 'Vulnerability Monitoring and Scanning'],
      ['SI-2', 'NIST-800-53', 'System and Information Integrity', 'Flaw Remediation'],
      ['SC-8', 'NIST-800-53', 'System and Communications Protection', 'Transmission Confidentiality and Integrity'],
      ['CP-9', 'NIST-800-53', 'Contingency Planning', 'System Backup'],
      ['CA-5', 'NIST-800-53', 'Assessment, Authorization, and Monitoring', 'Plan of Action and Milestones'],
    ] as const;
    for (const [id, framework, family, title] of controls) {
      await sql.query(
        `INSERT INTO compliance_controls (control_id, framework, family, title)
         VALUES ($1,$2,$3,$4) ON CONFLICT (control_id) DO NOTHING`,
        [id, framework, family, title],
      );
    }
    // control -> evidence source mappings (conmon check keys mirror the seeded checks)
    const mappings: Array<[string, 'audit_action' | 'posture_domain' | 'conmon_check', string]> = [
      ['IA-2', 'conmon_check', 'mfa_coverage'],
      ['AC-2', 'conmon_check', 'ca_baseline'],
      ['AC-6', 'conmon_check', 'priv_review'],
      ['RA-5', 'conmon_check', 'vuln_scan'],
      ['SI-2', 'conmon_check', 'patch_compliance'],
      ['SC-8', 'conmon_check', 'email_security'],
      ['CP-9', 'conmon_check', 'backup_success'],
      ['AU-6', 'conmon_check', 'audit_review'],
      ['CA-5', 'conmon_check', 'poam_aging'],
      ['AU-12', 'audit_action', 'posture.finding.create'],
      ['AC-2', 'audit_action', 'service_request.create'],
      ['IA-2', 'posture_domain', 'mfa'],
    ];
    for (const [controlId, source, sourceKey] of mappings) {
      await sql.query(
        `INSERT INTO control_mappings (control_id, source, source_key)
         VALUES ($1,$2,$3) ON CONFLICT (control_id, source, source_key) DO NOTHING`,
        [controlId, source, sourceKey],
      );
    }
```

- [ ] **Step 3: Re-run the seed (requires DB)**

Run: `npm run db:seed`
Expected: `seed complete`. (Skip if no local DB; CI covers it.)

- [ ] **Step 4: Typecheck and commit**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

```bash
git add apps/api/src/db/seed.ts
git commit -m "feat(seed): compliance permissions, control catalog, and evidence mappings"
```

### Task 3: Control-classification pure logic + unit test

The core of coverage: classify a control as `satisfied | partial | gap` from its mapped evidence signals. Pure and DB-free.

**Files:**
- Create: `apps/api/src/modules/compliance.ts`
- Create: `apps/api/test/compliance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/compliance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyControl, type ControlSignal } from '../src/modules/compliance.js';

const base: ControlSignal = { mapped: 0, satisfied: 0 };

describe('classifyControl', () => {
  it('returns "gap" when a control has no mappings', () => {
    expect(classifyControl({ ...base, mapped: 0, satisfied: 0 })).toBe('gap');
  });

  it('returns "satisfied" when every mapped signal is satisfied', () => {
    expect(classifyControl({ mapped: 3, satisfied: 3 })).toBe('satisfied');
  });

  it('returns "gap" when no mapped signal is satisfied', () => {
    expect(classifyControl({ mapped: 3, satisfied: 0 })).toBe('gap');
  });

  it('returns "partial" when some but not all signals are satisfied', () => {
    expect(classifyControl({ mapped: 3, satisfied: 2 })).toBe('partial');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace apps/api run test -- compliance`
Expected: FAIL — cannot resolve `../src/modules/compliance.js` / `classifyControl is not a function`.

- [ ] **Step 3: Create the module with the pure function**

Create `apps/api/src/modules/compliance.ts`:

```ts
// Compliance control coverage + tamper-evident evidence package (docs/nexus/08 §Q-R).
// Coverage is computed at read time from immutable sources (audit_logs hash-chain,
// posture_findings, conmon_runs); evidence is never a separately-writable ledger.
import { createHash } from 'node:crypto';
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type ControlStatus = 'satisfied' | 'partial' | 'gap';

export interface ControlSignal {
  mapped: number; // number of evidence mappings for the control
  satisfied: number; // how many are currently satisfied
}

/** Pure classification of a control's status from its evidence tally. */
export function classifyControl(s: ControlSignal): ControlStatus {
  if (s.mapped === 0 || s.satisfied === 0) return 'gap';
  if (s.satisfied >= s.mapped) return 'satisfied';
  return 'partial';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace apps/api run test -- compliance`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/compliance.ts apps/api/test/compliance.test.ts
git commit -m "feat(compliance): control-status classification with unit tests"
```

### Task 4: Compliance coverage, evidence package, and exception flow

**Files:**
- Modify: `apps/api/src/modules/compliance.ts` (append functions)

- [ ] **Step 1: Append the coverage + evidence + exception functions**

Append to `apps/api/src/modules/compliance.ts`:

```ts
interface ControlRow {
  control_id: string;
  framework: string;
  family: string;
  title: string;
}
interface MappingRow {
  control_id: string;
  source: 'audit_action' | 'posture_domain' | 'conmon_check';
  source_key: string;
}

/** Evaluate one mapping against the current org state; returns true if satisfied. */
async function evaluateMapping(
  sql: import('../db/pool.js').Sql,
  orgId: string,
  m: MappingRow,
): Promise<boolean> {
  if (m.source === 'audit_action') {
    const { rows } = await sql.query(
      `SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action=$2 LIMIT 1`,
      [orgId, m.source_key],
    );
    return rows.length > 0;
  }
  if (m.source === 'posture_domain') {
    const { rows } = await sql.query(
      `SELECT count(*)::int AS n FROM posture_findings
        WHERE organization_id=$1 AND domain=$2
          AND status NOT IN ('remediated','closed','accepted')`,
      [orgId, m.source_key],
    );
    return rows[0].n === 0; // satisfied when no open findings in the domain
  }
  // conmon_check: latest run for this check must be a pass
  const { rows } = await sql.query(
    `SELECT result FROM conmon_runs
      WHERE organization_id=$1 AND check_key=$2
      ORDER BY ran_at DESC LIMIT 1`,
    [orgId, m.source_key],
  );
  return rows[0]?.result === 'pass';
}

export interface ControlCoverage extends ControlRow {
  mapped: number;
  satisfied: number;
  status: ControlStatus;
}

/** Per-control coverage for an org, computed from mapped evidence. */
export async function controlCoverage(actor: Principal, orgId: string): Promise<ControlCoverage[]> {
  authorize(actor, 'compliance.read', { organizationId: orgId });
  const { controls, mappings } = await withSystemContext(async (sql) => {
    const controls = (await sql.query<ControlRow>('SELECT control_id, framework, family, title FROM compliance_controls ORDER BY control_id')).rows;
    const mappings = (await sql.query<MappingRow>('SELECT control_id, source, source_key FROM control_mappings')).rows;
    return { controls, mappings };
  });

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const out: ControlCoverage[] = [];
    for (const c of controls) {
      const ms = mappings.filter((m) => m.control_id === c.control_id);
      let satisfied = 0;
      for (const m of ms) if (await evaluateMapping(sql, orgId, m)) satisfied++;
      out.push({ ...c, mapped: ms.length, satisfied, status: classifyControl({ mapped: ms.length, satisfied }) });
    }
    return out;
  });
}

export interface EvidencePackage {
  organization_id: string;
  generated_at: string;
  controls: ControlCoverage[];
  summary: { satisfied: number; partial: number; gap: number };
  manifest_sha256: string;
}

/** Assemble a hash-stamped evidence package for an org. Read-only; itself audited. */
export async function evidencePackage(actor: Principal, orgId: string): Promise<EvidencePackage> {
  authorize(actor, 'compliance.read', { organizationId: orgId });
  const controls = await controlCoverage(actor, orgId);
  const summary = {
    satisfied: controls.filter((c) => c.status === 'satisfied').length,
    partial: controls.filter((c) => c.status === 'partial').length,
    gap: controls.filter((c) => c.status === 'gap').length,
  };
  const generated_at = new Date().toISOString();
  const body = JSON.stringify({ organization_id: orgId, generated_at, controls, summary });
  const manifest_sha256 = createHash('sha256').update(body).digest('hex');
  await audit(actor, { action: 'compliance.evidence_export', organizationId: orgId, resourceType: 'organization', resourceId: orgId, detail: { manifest_sha256, ...summary } });
  return { organization_id: orgId, generated_at, controls, summary, manifest_sha256 };
}

export interface RequestExceptionInput {
  findingId: string;
  justification: string;
  compensatingControl?: string;
  expiresAt?: string;
  organizationId?: string; // required for agent-initiated
}

/** Request a posture exception (SoD: a different principal approves). */
export async function requestException(actor: Principal, input: RequestExceptionInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required for agent-initiated exceptions');
  authorize(actor, 'posture.request_exception', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const f = (await sql.query('SELECT id FROM posture_findings WHERE id=$1 AND organization_id=$2', [input.findingId, orgId])).rows[0];
    if (!f) throw Errors.notFound('finding not found');
    const { rows } = await sql.query(
      `INSERT INTO posture_exceptions
         (organization_id, finding_id, requested_by, justification, compensating_control, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, input.findingId, actor.id, input.justification, input.compensatingControl ?? null, input.expiresAt ?? null],
    );
    const ex = rows[0];
    await audit(actor, { action: 'posture.exception.request', organizationId: orgId, resourceType: 'posture_exception', resourceId: ex.id, detail: { findingId: input.findingId } });
    publish('posture.exception_requested', orgId, { exception_id: ex.id, finding_id: input.findingId, org_id: orgId });
    return ex;
  });
}

/** Approve or reject a posture exception. Enforces separation of duties. */
export async function decideException(actor: Principal, exceptionId: string, approve: boolean) {
  authorize(actor, 'posture.approve_exception');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const ex = (await sql.query('SELECT * FROM posture_exceptions WHERE id=$1', [exceptionId])).rows[0];
    if (!ex) throw Errors.notFound('exception not found');
    if (ex.status !== 'requested') throw Errors.conflict(`exception already ${ex.status}`);
    if (ex.requested_by === actor.id) throw Errors.forbidden('separation of duties: requester cannot approve');
    const status = approve ? 'approved' : 'rejected';
    await sql.query('UPDATE posture_exceptions SET status=$1, decided_by=$2, decided_at=now() WHERE id=$3', [status, actor.id, exceptionId]);
    if (approve) {
      // Accepting an exception moves the underlying finding to 'accepted'.
      await sql.query("UPDATE posture_findings SET status='accepted' WHERE id=$1", [ex.finding_id]);
    }
    await audit(actor, { action: `posture.exception.${status}`, organizationId: ex.organization_id, resourceType: 'posture_exception', resourceId: exceptionId, detail: { findingId: ex.finding_id } });
    publish(approve ? 'posture.exception_approved' : 'posture.exception_rejected', ex.organization_id, { exception_id: exceptionId, finding_id: ex.finding_id });
    return { status };
  });
}

void can; // (re-exported convenience; kept for parity with other modules)
```

- [ ] **Step 2: Typecheck**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Run unit tests (still green)**

Run: `npm --workspace apps/api run test -- compliance`
Expected: PASS (4 tests; the new functions are DB-backed and covered by Task 7).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/compliance.ts
git commit -m "feat(compliance): coverage, evidence package, and exception SoD flow"
```

### Task 5: Compliance & exception routes

**Files:**
- Modify: `apps/api/src/http/routes.ts` (add import ~line 16 and route block after the Posture section ~line 318)

- [ ] **Step 1: Add the import**

In `apps/api/src/http/routes.ts`, after `import * as automation from '../modules/automation.js';` (line 15), add:

```ts
import * as compliance from '../modules/compliance.js';
```

- [ ] **Step 2: Add the routes**

In `apps/api/src/http/routes.ts`, immediately after the `posture/findings/:id/to-ticket` handler block (ends ~line 318), add:

```ts
  // ---------------- Compliance & evidence ----------------
  app.get('/api/v1/compliance/controls', async (req) => {
    await requirePrincipal(req);
    return withSystemContext(async (sql) => {
      const { rows } = await sql.query('SELECT control_id, framework, family, title, description FROM compliance_controls ORDER BY control_id');
      return { data: rows };
    });
  });

  app.get('/api/v1/compliance/coverage', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId! : q.organizationId;
    if (!orgId) throw Errors.badRequest('organizationId required');
    return { data: await compliance.controlCoverage(p, orgId) };
  });

  app.post('/api/v1/compliance/evidence-package', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ organizationId: z.string().uuid().optional() }).parse(req.query);
    const orgId = p.plane === 'customer' ? p.organizationId! : q.organizationId;
    if (!orgId) throw Errors.badRequest('organizationId required');
    return compliance.evidencePackage(p, orgId);
  });

  app.post('/api/v1/posture/findings/:id/exception', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        justification: z.string().min(5),
        compensatingControl: z.string().optional(),
        expiresAt: z.string().datetime().optional(),
        organizationId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const ex = await compliance.requestException(p, { findingId: id, ...body });
    reply.status(201);
    return ex;
  });

  app.post('/api/v1/posture/exceptions/:id/decide', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    return compliance.decideException(p, id, body.approve);
  });
```

- [ ] **Step 3: Typecheck and build**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): compliance coverage/evidence + posture exception routes"
```

### Task 6: Compliance web page

**Files:**
- Create: `apps/web/app/(app)/compliance/page.tsx`
- Modify: `apps/web/components/shell.tsx` (add a nav entry — see Step 2)

- [ ] **Step 1: Create the page**

Create `apps/web/app/(app)/compliance/page.tsx`:

```tsx
'use client';
import * as React from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';

interface Coverage {
  control_id: string;
  framework: string;
  family: string;
  title: string;
  mapped: number;
  satisfied: number;
  status: 'satisfied' | 'partial' | 'gap';
}

const tone = (s: Coverage['status']) => (s === 'satisfied' ? 'success' : s === 'partial' ? 'warning' : 'danger');

export default function CompliancePage() {
  const { can } = useAuth();
  const [rows, setRows] = React.useState<Coverage[] | null>(null);
  const [exporting, setExporting] = React.useState(false);

  React.useEffect(() => {
    api.get<{ data: Coverage[] }>('/compliance/coverage').then((r) => setRows(r.data)).catch(() => setRows([]));
  }, []);

  async function exportPackage() {
    setExporting(true);
    try {
      const pkg = await api.post<unknown>('/compliance/evidence-package');
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nexus-evidence-package.json';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const counts = (rows ?? []).reduce<Record<string, number>>((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {});

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compliance</h1>
          <p className="mt-1 text-sm text-muted">Control coverage computed from posture, continuous monitoring, and the audit trail.</p>
        </div>
        {can('compliance.read') && (
          <Button variant="outline" onClick={exportPackage} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export evidence package'}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Satisfied" value={counts.satisfied ?? 0} tone="success" />
        <StatCard label="Partial" value={counts.partial ?? 0} tone="warning" />
        <StatCard label="Gaps" value={counts.gap ?? 0} tone="danger" />
      </div>

      <Card>
        <CardHeader><CardTitle>Controls</CardTitle></CardHeader>
        <CardBody className="px-0 pt-0">
          {!rows ? (
            <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <DataTable<Coverage>
              rows={rows}
              empty={<EmptyState title="No controls" description="No compliance controls are configured." />}
              columns={[
                { key: 'id', header: 'Control', render: (c) => <span className="font-medium text-fg">{c.control_id}</span> },
                { key: 'framework', header: 'Framework', render: (c) => <span className="text-xs text-muted">{c.framework}</span> },
                { key: 'title', header: 'Title', render: (c) => <span className="text-sm text-fg">{c.title}</span> },
                { key: 'evidence', header: 'Evidence', render: (c) => <span className="tabular-nums text-xs text-muted">{c.satisfied}/{c.mapped}</span> },
                { key: 'status', header: 'Status', render: (c) => <Badge tone={tone(c.status)}>{c.status}</Badge> },
              ]}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Add a nav entry**

Open `apps/web/components/shell.tsx`, find the navigation array (the list of `{ href, label }` entries used to render the sidebar/nav — search for `'/posture'`). Add an entry next to it:

```tsx
  { href: '/compliance', label: 'Compliance' },
```

(Match the exact object shape used by the surrounding entries — if they include an icon field, use `lucide-react`'s `ShieldCheck`, imported at the top alongside the other icon imports.)

- [ ] **Step 3: Typecheck the web app**

Run: `npm --workspace apps/web run typecheck`
Expected: no errors. (If the nav array shape differs, adjust the added entry to match; do not introduce new fields.)

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/compliance/page.tsx" apps/web/components/shell.tsx
git commit -m "feat(web): compliance coverage page with evidence export"
```

### Task 7: Compliance integration test (skip-if-no-DB)

**Files:**
- Create: `apps/api/test/integration/compliance.int.test.ts`

- [ ] **Step 1: Write the integration test**

Create `apps/api/test/integration/compliance.int.test.ts`:

```ts
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { controlCoverage, requestException, decideException } from '../../src/modules/compliance.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const user = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: user.id, plane: user.plane, email: user.email, org: user.organization_id, roles: [] });
}

describeDb('compliance (integration)', () => {
  let analyst: Principal; // nexus SecurityAnalyst (compliance.manage + approve_exception)
  let acmeId: string;

  beforeAll(async () => {
    analyst = await principalByEmail('analyst@nexus.example.com');
    acmeId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM organizations WHERE name='Acme'")).rows[0].id,
    );
  });

  it('computes control coverage for an org', async () => {
    const coverage = await controlCoverage(analyst, acmeId);
    expect(coverage.length).toBeGreaterThan(0);
    for (const c of coverage) expect(['satisfied', 'partial', 'gap']).toContain(c.status);
  });

  it('enforces separation of duties on exceptions', async () => {
    const finding = await withSystemContext(async (sql) =>
      (await sql.query('SELECT id FROM posture_findings WHERE organization_id=$1 LIMIT 1', [acmeId])).rows[0],
    );
    const ex = await requestException(analyst, { findingId: finding.id, justification: 'compensating MFA in place', organizationId: acmeId });
    // same principal cannot approve their own request
    await expect(decideException(analyst, ex.id, true)).rejects.toThrow(/separation of duties/i);
  });
});
```

- [ ] **Step 2: Run DB-free (verifies clean skip)**

Run: `npm --workspace apps/api run test -- compliance.int`
Expected: the suite is **skipped** (no `DATABASE_URL`); overall run is green.

- [ ] **Step 3: (Optional, if local DB available) run with a DB**

Run: `DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus APP_DATABASE_URL=postgres://nexus_app:nexus_app@localhost:5432/nexus npm --workspace apps/api run test -- compliance.int`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/integration/compliance.int.test.ts
git commit -m "test(compliance): coverage + exception SoD integration tests"
```

---

## WP2 — Audit / SIEM export & integrity verification

### Task 8: Audit chain verification (pure) + unit test

**Files:**
- Modify: `apps/api/src/modules/audit.ts` (append)
- Create: `apps/api/test/audit-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/audit-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyChain, type AuditRow } from '../src/modules/audit.js';
import { createHash } from 'node:crypto';

// Rebuild the same payload+hash the writer uses, so we can construct valid chains.
function link(prev: string | null, row: Omit<AuditRow, 'prev_hash' | 'row_hash'>): AuditRow {
  const payload = JSON.stringify({
    actor: row.actor_id ?? null,
    action: row.action,
    resource: row.resource_id ?? null,
    detail: row.detail ?? {},
    at: row.created_at,
  });
  const row_hash = createHash('sha256').update((prev ?? '') + payload).digest('hex');
  return { ...row, prev_hash: prev, row_hash };
}

const r1 = link(null, { actor_id: 'a', action: 'x', resource_id: null, detail: {}, created_at: '2026-01-01T00:00:00.000Z' });
const r2 = link(r1.row_hash, { actor_id: 'a', action: 'y', resource_id: null, detail: {}, created_at: '2026-01-02T00:00:00.000Z' });

describe('verifyChain', () => {
  it('reports intact for a valid chain', () => {
    expect(verifyChain([r1, r2])).toEqual({ ok: true, checked: 2, brokenAt: null });
  });

  it('reports intact for an empty log', () => {
    expect(verifyChain([])).toEqual({ ok: true, checked: 0, brokenAt: null });
  });

  it('detects a tampered row', () => {
    const tampered = { ...r2, action: 'TAMPERED' };
    const res = verifyChain([r1, tampered]);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace apps/api run test -- audit-verify`
Expected: FAIL — `verifyChain is not a function`.

- [ ] **Step 3: Append the implementation**

Append to `apps/api/src/modules/audit.ts`:

```ts
export interface AuditRow {
  actor_id: string | null;
  action: string;
  resource_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  prev_hash: string | null;
  row_hash: string;
}

export interface ChainResult {
  ok: boolean;
  checked: number;
  brokenAt: number | null; // index of first divergence, or null
}

/** Recompute the hash chain over ordered rows; report the first divergence. Pure. */
export function verifyChain(rows: AuditRow[]): ChainResult {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const payload = JSON.stringify({
      actor: row.actor_id ?? null,
      action: row.action,
      resource: row.resource_id ?? null,
      detail: row.detail ?? {},
      at: row.created_at,
    });
    const expected = createHash('sha256').update((prev ?? '') + payload).digest('hex');
    if (expected !== row.row_hash || (row.prev_hash ?? null) !== prev) {
      return { ok: false, checked: i + 1, brokenAt: i };
    }
    prev = row.row_hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
```

Note: `created_at` here must be the ISO string of the stored timestamp. The verify route (Task 10) selects `to_char(created_at, ...)`-free by converting in JS — see that task for the exact query (it reads the raw `created_at` and the route formats consistently). The writer (`audit()`) used `new Date().toISOString()` at write time, so the route compares against the **stored** `row_hash` using the same serialization.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace apps/api run test -- audit-verify`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/audit.ts apps/api/test/audit-verify.test.ts
git commit -m "feat(audit): hash-chain verification with unit tests"
```

> **Important for Task 10:** The current `audit()` writer hashes `at: new Date().toISOString()` — a value that is **not** the same as the DB `created_at` column (set by `DEFAULT now()` only when the column isn't provided). To make `verifyChain` work against stored rows, Task 9 changes `audit()` to insert that exact ISO timestamp into `created_at` so the stored row is self-consistent. Do Task 9 before relying on `/audit/verify` over real data.

### Task 9: Persist the hashed timestamp + SIEM export formatter (pure) + unit test

**Files:**
- Modify: `apps/api/src/modules/audit.ts` (change the `INSERT` to store the hashed timestamp; append the CEF formatter)
- Create: `apps/api/test/audit-export.test.ts`

- [ ] **Step 1: Make the writer store the exact hashed timestamp**

In `apps/api/src/modules/audit.ts`, in the `audit()` function: capture the timestamp once and write it to `created_at` so the stored row matches the hash input. Replace the payload + insert section so it reads:

```ts
    const at = new Date().toISOString();
    const payload = JSON.stringify({
      actor: actor?.id ?? null,
      action: input.action,
      resource: input.resourceId ?? null,
      detail: input.detail ?? {},
      at,
    });
    const rowHash = createHash('sha256')
      .update((prevHash ?? '') + payload)
      .digest('hex');

    await sql.query(
      `INSERT INTO audit_logs
         (organization_id, actor_id, actor_plane, action, resource_type, resource_id, scope, detail, prev_hash, row_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.organizationId ?? actor?.organizationId ?? null,
        actor?.id ?? null,
        actor?.plane ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.scope ?? null,
        input.detail ?? {},
        prevHash,
        rowHash,
        at,
      ],
    );
```

(This is a backward-compatible column addition to the existing `INSERT`; `created_at` now carries the same ISO instant used in the hash.)

- [ ] **Step 2: Write the failing test for the CEF formatter**

Create `apps/api/test/audit-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toCef, type AuditRow } from '../src/modules/audit.js';

const row: AuditRow & { id: string; actor_plane: string | null; resource_type: string | null } = {
  id: '11111111-1111-1111-1111-111111111111',
  actor_id: 'actor-1',
  actor_plane: 'nexus',
  action: 'posture.finding.create',
  resource_type: 'posture_finding',
  resource_id: 'res-1',
  detail: { severity: 'high' },
  created_at: '2026-01-01T00:00:00.000Z',
  prev_hash: null,
  row_hash: 'abc',
};

describe('toCef', () => {
  it('produces a CEF line with the required prefix and key fields', () => {
    const line = toCef(row);
    expect(line.startsWith('CEF:0|Nexus|Platform|1.0|posture.finding.create|posture.finding.create|')).toBe(true);
    expect(line).toContain('suser=actor-1');
    expect(line).toContain('act=posture.finding.create');
    expect(line).toContain('externalId=11111111-1111-1111-1111-111111111111');
  });

  it('escapes pipes and backslashes in the header and equals in extensions', () => {
    const line = toCef({ ...row, action: 'a|b\\c' });
    expect(line).toContain('a\\|b\\\\c');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm --workspace apps/api run test -- audit-export`
Expected: FAIL — `toCef is not a function`.

- [ ] **Step 4: Append the SIEM sink interface + CEF formatter**

Append to `apps/api/src/modules/audit.ts`:

```ts
// --- SIEM export (docs/nexus/08 §Q; ADR for Sentinel integration is a documented seam) ---

export interface ExportableRow extends AuditRow {
  id: string;
  actor_plane: string | null;
  resource_type: string | null;
}

/** Pluggable SIEM destination. The real Microsoft Sentinel sink implements this. */
export interface SiemSink {
  push(records: ExportableRow[]): Promise<{ accepted: number }>;
}

/** Mock sink: records nothing externally, just acknowledges (dev/test default). */
export class LogSiemSink implements SiemSink {
  async push(records: ExportableRow[]): Promise<{ accepted: number }> {
    return { accepted: records.length };
  }
}

function cefEscapeHeader(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
function cefEscapeExt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, ' ');
}

/** Format one audit row as an ArcSight CEF line. Pure. */
export function toCef(row: ExportableRow): string {
  const name = cefEscapeHeader(row.action);
  const header = `CEF:0|Nexus|Platform|1.0|${name}|${name}|3`;
  const ext = [
    `externalId=${cefEscapeExt(row.id)}`,
    `rt=${cefEscapeExt(row.created_at)}`,
    `suser=${cefEscapeExt(row.actor_id ?? '')}`,
    `act=${cefEscapeExt(row.action)}`,
    `cs1Label=resourceType cs1=${cefEscapeExt(row.resource_type ?? '')}`,
    `cs2Label=resourceId cs2=${cefEscapeExt(row.resource_id ?? '')}`,
    `cs3Label=plane cs3=${cefEscapeExt(row.actor_plane ?? '')}`,
  ].join(' ');
  return `${header}|${ext}`;
}

/** Serialize rows for export in the requested format. Pure. */
export function formatExport(rows: ExportableRow[], format: 'ndjson' | 'cef'): string {
  if (format === 'cef') return rows.map(toCef).join('\n');
  return rows.map((r) => JSON.stringify(r)).join('\n');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm --workspace apps/api run test -- audit-export`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/audit.ts apps/api/test/audit-export.test.ts
git commit -m "feat(audit): SIEM export (NDJSON/CEF) + sink adapter; persist hashed timestamp"
```

### Task 10: Audit export & verify routes

**Files:**
- Modify: `apps/api/src/http/routes.ts` (extend the Audit section ~line 401-427)

- [ ] **Step 1: Add the import for the audit helpers**

In `apps/api/src/http/routes.ts`, add near the other module imports (after line 16):

```ts
import { verifyChain, formatExport, type ExportableRow } from '../modules/audit.js';
```

- [ ] **Step 2: Add the export + verify routes**

In `apps/api/src/http/routes.ts`, inside `registerRoutes`, after the existing `GET /api/v1/audit-logs` handler (ends ~line 427), add:

```ts
  // Streamed SIEM export (NDJSON or CEF). Scoped for customers; nexus sees assigned orgs.
  app.get('/api/v1/audit/export', async (req, reply) => {
    const p = await requirePrincipal(req);
    authorize(p, 'audit.read');
    const q = z
      .object({ format: z.enum(['ndjson', 'cef']).optional(), since: z.string().optional(), limit: z.coerce.number().optional() })
      .parse(req.query);
    const format = q.format ?? 'ndjson';
    const result = await withOrgContext(orgContextFor(p), async (sql) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (p.plane === 'customer') {
        params.push(p.organizationId);
        where.push(`organization_id = $${params.length}`);
      }
      if (q.since) {
        params.push(q.since);
        where.push(`created_at >= $${params.length}`);
      }
      const limit = Math.min(q.limit ?? 1000, 5000);
      const { rows } = await sql.query(
        `SELECT id, actor_id, actor_plane, action, resource_type, resource_id, detail,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                prev_hash, row_hash
           FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at ASC LIMIT ${limit}`,
        params,
      );
      return rows as ExportableRow[];
    });
    await audit(p, { action: 'audit.export', detail: { format, count: result.length } });
    reply
      .type(format === 'cef' ? 'text/plain' : 'application/x-ndjson')
      .send(formatExport(result, format));
  });

  // Integrity check: recompute the hash chain and report the first divergence.
  app.get('/api/v1/audit/verify', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'audit.read');
    if (p.plane !== 'nexus') throw Errors.forbidden('chain verification is a platform operation');
    return withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT actor_id, action, resource_id, detail,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                prev_hash, row_hash
           FROM audit_logs ORDER BY created_at ASC`,
      );
      return verifyChain(rows as any);
    });
  });
```

Note: this requires `audit` to be imported in `routes.ts`. Add to the imports if not present:

```ts
import { audit } from '../modules/audit.js';
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): audit SIEM export + hash-chain verify routes"
```

---

## WP3 — JIT elevation & break-glass

### Task 11: Elevation migration

**Files:**
- Create: `apps/api/src/db/migrations/0006_elevation.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/src/db/migrations/0006_elevation.sql`:

```sql
-- JIT privilege elevation + break-glass (docs/nexus/02 §E.11). Platform-internal,
-- no RLS — read via the system context (mirrors automation_rules in 0004); the API
-- layer enforces authorization. loadPrincipal() reads ACTIVE, non-expired grants to
-- augment a principal's permissions.
CREATE TABLE elevation_grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES organizations(id) ON DELETE CASCADE, -- nullable: platform scope
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_permissions  text[] NOT NULL DEFAULT '{}',
  reason               text NOT NULL,
  break_glass          boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','active','expired','revoked','rejected')),
  requested_by         uuid REFERENCES users(id),
  approver_id          uuid REFERENCES users(id),
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_elevation_user_active ON elevation_grants(user_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON elevation_grants TO nexus_app;
```

- [ ] **Step 2: Apply (requires DB) / defer to CI**

Run: `npm run db:migrate`
Expected: `apply 0006_elevation.sql`. (Skip locally if no DB; CI applies it.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0006_elevation.sql
git commit -m "feat(db): elevation_grants table (0006)"
```

### Task 12: Seed elevation permissions

**Files:**
- Modify: `apps/api/src/db/seed.ts`

- [ ] **Step 1: Add permissions and assign to roles**

In `apps/api/src/db/seed.ts`, add to `PERMISSIONS`:

```ts
  ['elevation.request', 'platform_admin'],
  ['elevation.approve', 'platform_admin'],
  ['elevation.break_glass', 'platform_admin'],
```

Grant: append `'elevation.request'` to `Tier2`, `SecurityAnalyst`, and `ServiceDeskManager`; append `'elevation.approve'` to `ServiceDeskManager`; append `'elevation.break_glass'` to `SecurityAnalyst` (the emergency role). Example for `ServiceDeskManager.perms` — add `'elevation.request', 'elevation.approve'`.

- [ ] **Step 2: Typecheck and (if DB) re-seed**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/seed.ts
git commit -m "feat(seed): elevation permissions (request/approve/break-glass)"
```

### Task 13: Elevation pure logic + unit test

**Files:**
- Create: `apps/api/src/modules/elevation.ts`
- Create: `apps/api/test/elevation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/elevation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isGrantActive, mergeGrantedPermissions, type GrantRow } from '../src/modules/elevation.js';

const now = new Date('2026-06-11T12:00:00.000Z');

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'g1',
    user_id: 'u1',
    granted_permissions: ['ticket.assign'],
    status: 'active',
    break_glass: false,
    expires_at: '2026-06-11T13:00:00.000Z',
    ...overrides,
  };
}

describe('isGrantActive', () => {
  it('is true for an active, unexpired grant', () => {
    expect(isGrantActive(grant(), now)).toBe(true);
  });
  it('is false once expired', () => {
    expect(isGrantActive(grant({ expires_at: '2026-06-11T11:00:00.000Z' }), now)).toBe(false);
  });
  it('is false when status is not active', () => {
    expect(isGrantActive(grant({ status: 'requested' }), now)).toBe(false);
  });
  it('treats a null expiry as non-expiring', () => {
    expect(isGrantActive(grant({ expires_at: null }), now)).toBe(true);
  });
});

describe('mergeGrantedPermissions', () => {
  it('unions base perms with active grants and dedupes', () => {
    const merged = mergeGrantedPermissions(['ticket.read.own'], [grant(), grant({ granted_permissions: ['ticket.read.own', 'audit.read'] })], now);
    expect(new Set(merged)).toEqual(new Set(['ticket.read.own', 'ticket.assign', 'audit.read']));
  });
  it('ignores expired grants', () => {
    const merged = mergeGrantedPermissions(['ticket.read.own'], [grant({ expires_at: '2020-01-01T00:00:00.000Z' })], now);
    expect(merged).toEqual(['ticket.read.own']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/api run test -- elevation`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module with pure helpers**

Create `apps/api/src/modules/elevation.ts`:

```ts
// JIT elevation & break-glass (docs/nexus/02 §E.11). Pure helpers here are unit-tested;
// the DB-backed request/approve/break-glass functions are appended in the next task.
export interface GrantRow {
  id: string;
  user_id: string;
  granted_permissions: string[];
  status: string;
  break_glass: boolean;
  expires_at: string | null;
}

/** Is a grant currently effective? Active status and not past expiry. Pure. */
export function isGrantActive(g: GrantRow, now = new Date()): boolean {
  if (g.status !== 'active') return false;
  if (g.expires_at === null) return true;
  return new Date(g.expires_at).getTime() > now.getTime();
}

/** Union base permissions with all active grants' permissions (deduped). Pure. */
export function mergeGrantedPermissions(base: string[], grants: GrantRow[], now = new Date()): string[] {
  const set = new Set(base);
  for (const g of grants) if (isGrantActive(g, now)) for (const p of g.granted_permissions) set.add(p);
  return [...set];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/api run test -- elevation`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/elevation.ts apps/api/test/elevation.test.ts
git commit -m "feat(elevation): grant-active + permission-merge pure logic with tests"
```

### Task 14: Elevation request / approve / break-glass (DB-backed)

**Files:**
- Modify: `apps/api/src/modules/elevation.ts` (append)

- [ ] **Step 1: Append the DB-backed functions**

Append to `apps/api/src/modules/elevation.ts`:

```ts
import { withSystemContext } from '../db/pool.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { createPage } from './oncall.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

const DEFAULT_TTL_MINUTES = 60;

export interface RequestElevationInput {
  permissions: string[];
  reason: string;
  organizationId?: string | null;
}

/** Request a time-boxed elevation. Approved separately (SoD). */
export async function requestElevation(actor: Principal, input: RequestElevationInput) {
  authorize(actor, 'elevation.request', { organizationId: input.organizationId ?? undefined });
  if (!input.permissions.length) throw Errors.badRequest('at least one permission is required');
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO elevation_grants (organization_id, user_id, granted_permissions, reason, requested_by, status)
       VALUES ($1,$2,$3,$4,$5,'requested') RETURNING *`,
      [input.organizationId ?? null, actor.id, input.permissions, input.reason, actor.id],
    );
    const g = rows[0];
    await audit(actor, { action: 'elevation.request', organizationId: g.organization_id, resourceType: 'elevation_grant', resourceId: g.id, detail: { permissions: input.permissions } });
    publish('elevation.requested', g.organization_id, { grant_id: g.id, user_id: actor.id });
    return g;
  });
}

/** Approve a requested elevation, activating it with a TTL. SoD enforced. */
export async function approveElevation(actor: Principal, grantId: string, ttlMinutes = DEFAULT_TTL_MINUTES) {
  authorize(actor, 'elevation.approve');
  return withSystemContext(async (sql) => {
    const g = (await sql.query('SELECT * FROM elevation_grants WHERE id=$1', [grantId])).rows[0];
    if (!g) throw Errors.notFound('grant not found');
    if (g.status !== 'requested') throw Errors.conflict(`grant already ${g.status}`);
    if (g.requested_by === actor.id) throw Errors.forbidden('separation of duties: requester cannot approve');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    await sql.query("UPDATE elevation_grants SET status='active', approver_id=$1, expires_at=$2 WHERE id=$3", [actor.id, expiresAt, grantId]);
    await audit(actor, { action: 'elevation.approve', organizationId: g.organization_id, resourceType: 'elevation_grant', resourceId: grantId, detail: { expiresAt } });
    publish('elevation.activated', g.organization_id, { grant_id: grantId, user_id: g.user_id, expires_at: expiresAt });
    return { status: 'active', expires_at: expiresAt };
  });
}

/** Break-glass: immediate, self-approved, LOUD elevation (critical audit + on-call page). */
export async function breakGlass(actor: Principal, input: RequestElevationInput, ttlMinutes = DEFAULT_TTL_MINUTES) {
  authorize(actor, 'elevation.break_glass', { organizationId: input.organizationId ?? undefined });
  if (!input.permissions.length) throw Errors.badRequest('at least one permission is required');
  const grant = await withSystemContext(async (sql) => {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const { rows } = await sql.query(
      `INSERT INTO elevation_grants (organization_id, user_id, granted_permissions, reason, requested_by, approver_id, break_glass, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$5,true,'active',$6) RETURNING *`,
      [input.organizationId ?? null, actor.id, input.permissions, input.reason, actor.id, expiresAt],
    );
    return rows[0];
  });
  await audit(actor, { action: 'elevation.break_glass', organizationId: grant.organization_id, resourceType: 'elevation_grant', resourceId: grant.id, scope: 'critical', detail: { permissions: input.permissions, reason: input.reason } });
  publish('elevation.break_glass', grant.organization_id, { grant_id: grant.id, user_id: actor.id });
  // Page on-call so break-glass is never silent.
  try {
    await createPage(actor, { organizationId: grant.organization_id ?? undefined, severity: 'Sev1' });
  } catch {
    // Paging is best-effort; the critical audit event is the durable record.
  }
  return grant;
}

/** Active, non-expired grants for a user (read by loadPrincipal). */
export async function activeGrantsFor(userId: string): Promise<GrantRow[]> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, user_id, granted_permissions, status, break_glass,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
         FROM elevation_grants
        WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    );
    return rows as GrantRow[];
  });
}
```

Note: confirm `createPage`'s signature in `apps/api/src/modules/oncall.ts` matches `createPage(actor, { organizationId?, severity?, ticketId?, scheduleId? })` (it does, per the route in `routes.ts`). If the parameter names differ, adapt the call accordingly.

- [ ] **Step 2: Typecheck**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/elevation.ts
git commit -m "feat(elevation): request/approve/break-glass with audit + on-call page"
```

### Task 15: Wire active grants into loadPrincipal

**Files:**
- Modify: `apps/api/src/auth/principal.ts` (~line 33-46)

- [ ] **Step 1: Apply active grants when resolving a principal**

In `apps/api/src/auth/principal.ts`, add an import at the top:

```ts
import { activeGrantsFor, mergeGrantedPermissions } from '../modules/elevation.js';
```

Then, inside `loadPrincipal`, after `permissions = permRows.map(...)` and before the `return { ... }`, add:

```ts
    // JIT elevation: union any active, non-expired grants into the effective permissions.
    const grants = await activeGrantsFor(claims.sub);
    const elevated = grants.length > 0;
    permissions = mergeGrantedPermissions(permissions, grants);
```

And change the returned object's `elevated` field from `elevated: false, // ...` to:

```ts
      elevated,
```

- [ ] **Step 2: Typecheck**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors. (Existing `pdp.test.ts` does not call `loadPrincipal`, so unit tests remain green and DB-free.)

- [ ] **Step 3: Run the full API test suite**

Run: `npm --workspace apps/api run test`
Expected: PASS (all suites; DB-backed ones skipped).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/auth/principal.ts
git commit -m "feat(auth): apply active elevation grants to principal permissions"
```

### Task 16: Elevation routes

**Files:**
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Add the import**

In `apps/api/src/http/routes.ts`, add:

```ts
import * as elevation from '../modules/elevation.js';
```

- [ ] **Step 2: Add the routes**

In `apps/api/src/http/routes.ts`, after the Automation section (~line 399), add:

```ts
  // ---------------- JIT elevation & break-glass ----------------
  app.post('/api/v1/elevation/request', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ permissions: z.array(z.string()).min(1), reason: z.string().min(5), organizationId: z.string().uuid().optional() })
      .parse(req.body);
    const g = await elevation.requestElevation(p, body);
    reply.status(201);
    return g;
  });

  app.post('/api/v1/elevation/:id/approve', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ ttlMinutes: z.number().int().min(5).max(480).optional() }).parse(req.body ?? {});
    return elevation.approveElevation(p, id, body.ttlMinutes);
  });

  app.post('/api/v1/elevation/break-glass', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z
      .object({ permissions: z.array(z.string()).min(1), reason: z.string().min(5), organizationId: z.string().uuid().optional() })
      .parse(req.body);
    const g = await elevation.breakGlass(p, body);
    reply.status(201);
    return g;
  });

  app.get('/api/v1/elevation', async (req) => {
    const p = await requirePrincipal(req);
    const grants = await elevation.activeGrantsFor(p.id);
    return { data: grants };
  });
```

- [ ] **Step 3: Typecheck and build**

Run: `npm --workspace apps/api run typecheck && npm --workspace apps/api run build`
Expected: no errors; build emits to `dist/`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): JIT elevation request/approve/break-glass routes"
```

---

## WP4 — Secure attachments

### Task 17: Add @fastify/multipart and register it

**Files:**
- Modify: `apps/api/package.json` (dependencies)
- Modify: `apps/api/src/server.ts` (register the plugin)

- [ ] **Step 1: Install the dependency**

Run: `npm --workspace apps/api install @fastify/multipart@^8.3.0`
Expected: `package.json` gains the dependency and `package-lock.json` updates.

- [ ] **Step 2: Register the plugin with a size cap**

In `apps/api/src/server.ts`, add the import after the other `@fastify/*` imports (line 4):

```ts
import multipart from '@fastify/multipart';
```

And register it after the rate-limit registration (~line 36), before CORS:

```ts
  // Multipart for attachment uploads (10 MiB per file; SSRF-safe streaming download).
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
```

- [ ] **Step 3: Typecheck and commit**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

```bash
git add apps/api/package.json package-lock.json apps/api/src/server.ts
git commit -m "chore(api): add and register @fastify/multipart for uploads"
```

### Task 18: Attachments migration

**Files:**
- Create: `apps/api/src/db/migrations/0007_attachments.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/src/db/migrations/0007_attachments.sql`:

```sql
-- Ticket attachments (tenant, RLS). Bytes live in a BlobStore (local-fs mock here);
-- this table is the metadata + scan-status system-of-record. Infected files are never
-- served (docs/nexus/08 §Q.3 attachment handling, US-013).
CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id      uuid REFERENCES ticket_comments(id) ON DELETE SET NULL,
  filename        text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  scan_status     text NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending','clean','infected','error')),
  storage_key     text NOT NULL,
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_attachments_ticket ON attachments(ticket_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_isolation ON attachments
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO nexus_app;
```

- [ ] **Step 2: Apply (requires DB) / defer to CI**

Run: `npm run db:migrate`
Expected: `apply 0007_attachments.sql`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0007_attachments.sql
git commit -m "feat(db): attachments table with RLS (0007)"
```

### Task 19: Storage + scanner adapters and upload validation (pure) + unit test

**Files:**
- Create: `apps/api/src/modules/storage.ts`
- Create: `apps/api/test/attachments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/attachments.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateUpload, MockScanner, ALLOWED_CONTENT_TYPES } from '../src/modules/storage.js';

describe('validateUpload', () => {
  it('accepts an allowed type within the size cap', () => {
    expect(validateUpload({ contentType: 'application/pdf', size: 1000 })).toEqual({ ok: true });
  });
  it('rejects a disallowed content type', () => {
    const r = validateUpload({ contentType: 'application/x-msdownload', size: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/content type/i);
  });
  it('rejects an oversized file', () => {
    const r = validateUpload({ contentType: 'application/pdf', size: 11 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/size/i);
  });
  it('exposes a non-empty allow-list', () => {
    expect(ALLOWED_CONTENT_TYPES.length).toBeGreaterThan(0);
  });
});

describe('MockScanner', () => {
  it('flags the EICAR test string as infected', async () => {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    expect(await new MockScanner().scan(Buffer.from(eicar))).toBe('infected');
  });
  it('treats normal content as clean', async () => {
    expect(await new MockScanner().scan(Buffer.from('hello world'))).toBe('clean');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/api run test -- attachments`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the adapters + validator**

Create `apps/api/src/modules/storage.ts`:

```ts
// Storage + malware-scan adapters for attachments. The mock implementations are the
// dev/test default; production swaps a real object store (S3/Azure Blob) and AV
// (ClamAV/Defender) behind these same interfaces. (docs/nexus/08 §Q.3, US-013.)
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type UploadCheck = { ok: true } | { ok: false; reason: string };

/** Validate an upload's content type and size. Pure. */
export function validateUpload(meta: { contentType: string; size: number }): UploadCheck {
  if (!ALLOWED_CONTENT_TYPES.includes(meta.contentType)) {
    return { ok: false, reason: `disallowed content type: ${meta.contentType}` };
  }
  if (meta.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `file size ${meta.size} exceeds cap ${MAX_ATTACHMENT_BYTES}` };
  }
  return { ok: true };
}

export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Local-filesystem mock blob store (never serves bytes by URL — gov-egress-safe). */
export class LocalBlobStore implements BlobStore {
  constructor(private root = process.env.BLOB_DIR ?? join(tmpdir(), 'nexus-blobs')) {}
  private path(key: string) {
    return join(this.root, key);
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export type ScanResult = 'clean' | 'infected';

export interface MalwareScanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}

const EICAR = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/** Mock scanner: flags the industry-standard EICAR test string; everything else clean. */
export class MockScanner implements MalwareScanner {
  async scan(bytes: Buffer): Promise<ScanResult> {
    return bytes.includes(EICAR) ? 'infected' : 'clean';
  }
}

// Default singletons used by the attachments module (swappable in tests/production).
export const blobStore: BlobStore = new LocalBlobStore();
export const scanner: MalwareScanner = new MockScanner();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/api run test -- attachments`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/storage.ts apps/api/test/attachments.test.ts
git commit -m "feat(storage): blob + scanner adapters and upload validation with tests"
```

### Task 20: Attachments module (upload, download, list)

**Files:**
- Create: `apps/api/src/modules/attachments.ts`

- [ ] **Step 1: Create the module**

Create `apps/api/src/modules/attachments.ts`:

```ts
// Ticket attachments: validate -> store -> scan -> serve (org-scoped streaming).
// Infected files are recorded but never served (docs/nexus/08 §Q.3, US-013).
import { createHash, randomUUID } from 'node:crypto';
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import { blobStore, scanner, validateUpload } from './storage.js';
import type { Principal } from '../types.js';

export interface UploadInput {
  ticketId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  commentId?: string | null;
}

export async function upload(actor: Principal, input: UploadInput) {
  const check = validateUpload({ contentType: input.contentType, size: input.bytes.length });
  if (!check.ok) throw Errors.validation(check.reason);

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT id, organization_id FROM tickets WHERE id=$1', [input.ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.comment', { organizationId: t.organization_id });

    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = `${t.organization_id}/${input.ticketId}/${randomUUID()}`;
    await blobStore.put(storageKey, input.bytes);
    const scanStatus = await scanner.scan(input.bytes);

    const { rows } = await sql.query(
      `INSERT INTO attachments
         (organization_id, ticket_id, comment_id, filename, content_type, size_bytes, sha256, scan_status, storage_key, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, filename, content_type, size_bytes, scan_status, created_at`,
      [t.organization_id, input.ticketId, input.commentId ?? null, input.filename, input.contentType, input.bytes.length, sha256, scanStatus, storageKey, actor.id],
    );
    const att = rows[0];
    await audit(actor, { action: 'attachment.upload', organizationId: t.organization_id, resourceType: 'attachment', resourceId: att.id, detail: { scan_status: scanStatus, sha256 } });
    return att;
  });
}

export async function listForTicket(actor: Principal, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, filename, content_type, size_bytes, scan_status, created_at
         FROM attachments WHERE ticket_id=$1 ORDER BY created_at DESC`,
      [ticketId],
    );
    return rows;
  });
}

export interface DownloadResult {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Org-scoped streaming download. Infected (or not-yet-clean) files are never served. */
export async function download(actor: Principal, attachmentId: string): Promise<DownloadResult> {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const a = (await sql.query('SELECT * FROM attachments WHERE id=$1', [attachmentId])).rows[0];
    if (!a) throw Errors.notFound('attachment not found'); // RLS already scopes by org
    authorize(actor, 'ticket.comment', { organizationId: a.organization_id });
    if (a.scan_status !== 'clean') throw Errors.forbidden(`attachment is ${a.scan_status}; download blocked`);
    const bytes = await blobStore.get(a.storage_key);
    await audit(actor, { action: 'attachment.download', organizationId: a.organization_id, resourceType: 'attachment', resourceId: a.id });
    return { filename: a.filename, contentType: a.content_type, bytes };
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm --workspace apps/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/attachments.ts
git commit -m "feat(attachments): upload/scan/list/scoped-download module"
```

### Task 21: Attachment routes

**Files:**
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Add the import**

In `apps/api/src/http/routes.ts`:

```ts
import * as attachments from '../modules/attachments.js';
```

- [ ] **Step 2: Add the routes**

In `apps/api/src/http/routes.ts`, after the ticket routes (after the `escalate` handler ~line 230), add:

```ts
  // ---------------- Attachments ----------------
  app.post('/api/v1/tickets/:id/attachments', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const file = await (req as any).file();
    if (!file) throw Errors.badRequest('multipart file field required');
    const bytes = await file.toBuffer();
    const att = await attachments.upload(p, {
      ticketId: id,
      filename: file.filename,
      contentType: file.mimetype,
      bytes,
    });
    reply.status(201);
    return att;
  });

  app.get('/api/v1/tickets/:id/attachments', async (req) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { data: await attachments.listForTicket(p, id) };
  });

  app.get('/api/v1/attachments/:id', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await attachments.download(p, id);
    reply
      .header('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`)
      .type(result.contentType)
      .send(result.bytes);
  });
```

- [ ] **Step 3: Typecheck and build**

Run: `npm --workspace apps/api run typecheck && npm --workspace apps/api run build`
Expected: no errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): attachment upload, list, and scoped download routes"
```

### Task 22: Attachments integration test (skip-if-no-DB)

**Files:**
- Create: `apps/api/test/integration/attachments.int.test.ts`

- [ ] **Step 1: Write the integration test**

Create `apps/api/test/integration/attachments.int.test.ts`:

```ts
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { upload, download, listForTicket } from '../../src/modules/attachments.js';
import type { Principal } from '../../src/types.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describeDb('attachments (integration)', () => {
  let agent: Principal;
  let ticketId: string;

  beforeAll(async () => {
    const u = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id, plane, email, organization_id FROM users WHERE email='agent@nexus.example.com'")).rows[0],
    );
    agent = await loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
    ticketId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM tickets WHERE ticket_number='ACME-000001'")).rows[0].id,
    );
  });

  it('uploads a clean file and serves it', async () => {
    const att = await upload(agent, { ticketId, filename: 'note.txt', contentType: 'text/plain', bytes: Buffer.from('hello') });
    expect(att.scan_status).toBe('clean');
    const list = await listForTicket(agent, ticketId);
    expect(list.find((a: any) => a.id === att.id)).toBeTruthy();
    const dl = await download(agent, att.id);
    expect(dl.bytes.toString()).toBe('hello');
  });

  it('stores an infected file but blocks download', async () => {
    const att = await upload(agent, { ticketId, filename: 'virus.txt', contentType: 'text/plain', bytes: Buffer.from(EICAR) });
    expect(att.scan_status).toBe('infected');
    await expect(download(agent, att.id)).rejects.toThrow(/infected/i);
  });
});
```

- [ ] **Step 2: Run DB-free (verifies clean skip)**

Run: `npm --workspace apps/api run test -- attachments.int`
Expected: skipped; overall run green.

- [ ] **Step 3: Run the full suite once more**

Run: `npm --workspace apps/api run test`
Expected: PASS — all unit suites green; integration suites skipped (no DB).

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/integration/attachments.int.test.ts
git commit -m "test(attachments): clean upload + EICAR block integration tests"
```

---

## Task 23: CI — Postgres service + run integration tests

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Inspect the existing workflow**

Run: `cat .github/workflows/ci.yml`
Expected: a job that runs typecheck → test → build plus `npm audit` and a secret scan. Note the job name and structure.

- [ ] **Step 2: Add a Postgres service and migrate+seed before tests**

Edit `.github/workflows/ci.yml` to add a Postgres service to the test job and run migrate+seed so integration tests execute. Add under the test job:

```yaml
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: nexus
          POSTGRES_PASSWORD: nexus
          POSTGRES_DB: nexus
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U nexus" --health-interval 5s
          --health-timeout 5s --health-retries 10
```

And before the test step, add steps to create the app role, migrate, and seed (the app role + grants mirror local dev):

```yaml
      - name: Prepare database
        env:
          PGPASSWORD: nexus
        run: |
          psql -h localhost -U nexus -d nexus -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='nexus_app') THEN CREATE ROLE nexus_app LOGIN PASSWORD 'nexus_app'; END IF; END \$\$;"
          psql -h localhost -U nexus -d nexus -c "GRANT USAGE ON SCHEMA public TO nexus_app;"
      - name: Migrate & seed
        env:
          DATABASE_URL: postgres://nexus:nexus@localhost:5432/nexus
          APP_DATABASE_URL: postgres://nexus_app:nexus_app@localhost:5432/nexus
        run: |
          npm --workspace apps/api run migrate
          npm --workspace apps/api run seed
```

Then set the env on the existing test step so integration suites run:

```yaml
      - name: Test
        env:
          DATABASE_URL: postgres://nexus:nexus@localhost:5432/nexus
          APP_DATABASE_URL: postgres://nexus_app:nexus_app@localhost:5432/nexus
        run: npm --workspace apps/api run test
```

Note: confirm the migration `0001_init.sql` creates the `nexus_app` role and its grants; if it does, the "Prepare database" step is redundant for role creation but harmless (it's guarded by `IF NOT EXISTS`). Keep it so the workflow is self-sufficient regardless.

- [ ] **Step 3: Add CodeQL, SBOM, and dependency scanning as a separate job**

Append a new job to `.github/workflows/ci.yml`:

```yaml
  security:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Generate SBOM (CycloneDX)
        run: npx --yes @cyclonedx/cyclonedx-npm@^1 --output-file sbom.json || echo "sbom generation non-fatal"
      - uses: actions/upload-artifact@v4
        with: { name: sbom, path: sbom.json, if-no-files-found: ignore }
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with: { languages: javascript-typescript }
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
      - name: Dependency review
        uses: actions/dependency-review-action@v4
        if: github.event_name == 'pull_request'
        with: { fail-on-severity: high }
```

- [ ] **Step 4: Validate the workflow YAML locally**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); console.log('lines:', y.split('\n').length)"`
Expected: prints a line count (sanity check the file is well-formed; YAML is validated by GitHub on push).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: Postgres service for integration tests + CodeQL, SBOM, dependency review"
```

---

## Task 24: Final verification

- [ ] **Step 1: Full typecheck across workspaces**

Run: `npm run typecheck`
Expected: no errors in `apps/api` or `apps/web`.

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: API compiles to `dist/`; web builds successfully.

- [ ] **Step 3: Full API test suite (DB-free)**

Run: `npm --workspace apps/api run test`
Expected: all unit suites pass; integration suites skipped (no `DATABASE_URL`). Capture the pass/skip counts.

- [ ] **Step 4: (If a local DB is available) full integration run**

Run: `npm run db:up && npm run db:migrate && npm run db:seed && DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus APP_DATABASE_URL=postgres://nexus_app:nexus_app@localhost:5432/nexus npm --workspace apps/api run test`
Expected: unit + integration suites all pass.

- [ ] **Step 5: Update the README enterprise-hardening section**

Add the new capabilities (compliance coverage + evidence export, audit SIEM export + chain verify, JIT elevation/break-glass, secure attachments) to the "Enterprise hardening" list in `README.md`, then commit:

```bash
git add README.md
git commit -m "docs: note Tier 1 security & compliance capabilities in README"
```

---

## Self-review checklist (completed during authoring)

- **Spec coverage:** WP1 (Tasks 1–7), WP2 (Tasks 8–10), WP3 (Tasks 11–16), WP4 (Tasks 17–22), WP10 scaffolding + CI (Tasks 0, 23). WP11 (observability) and Tier 2 packages are in their own subsequent plans, as designed.
- **Deviation from spec:** `evidence_items` table dropped in favor of read-time evidence computation (documented in Design notes) — surfaces the same API with stronger tamper-evidence.
- **Type consistency:** `ControlSignal`/`classifyControl`, `AuditRow`/`ExportableRow`/`verifyChain`/`toCef`/`formatExport`, `GrantRow`/`isGrantActive`/`mergeGrantedPermissions`/`activeGrantsFor`, `UploadCheck`/`validateUpload`/`BlobStore`/`MalwareScanner` are defined once and reused consistently across module, routes, and tests.
- **No placeholders:** every code step contains complete code; every command has an expected result.
```

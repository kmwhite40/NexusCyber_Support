# SBS New-User Onboarding & Entra/Cloud PC Provisioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the SBS "New User Computer/Network Access Form" into an Anchor catalog request that captures every field, protects the PII, and — after approval — provisions the Entra account, license baseline, group memberships, Temporary Access Pass, and Windows 365 Cloud PC through a resumable, previewable engine.

**Architecture:** Two phases. Phase 1 extends the existing forms subsystem (conditional visibility, sensitive fields, server-sourced select options) and seeds the SBS fields — shippable on its own. Phase 2 adds a Microsoft Graph write path and a run/step state machine whose dry-run and execution share one code path.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify 5, Postgres via `pg` with RLS, Zod, Vitest, Next.js 15 App Router, React 18.

**Spec:** `docs/superpowers/specs/2026-09-01-sbs-user-onboarding-provisioning-design.md`

## Global Constraints

- **Migration numbering:** `0053_onboarding_forms_pii.sql`, `0054_provisioning_runs.sql`. Migrations are **idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO UPDATE`) — `migrate()` runs on every API boot from `server.ts:29`.
- **DB access:** `withOrgContext(orgContextFor(actor), async (sql) => …)` for caller-scoped work; `withSystemContext(async (sql) => …)` for engine/job work. Both from `../db/pool.js`. `Sql` is `pg.PoolClient`.
- **Authorization:** `authorize(actor, '<permission>', { organizationId })` from `../authz/pdp.js`. Never hand-roll permission checks.
- **Audit:** `audit(actor, { action, organizationId, resourceType, resourceId, detail })` from `./audit.js`.
- **Errors:** `Errors.badRequest(msg)` / `Errors.notFound(msg)` / `Errors.forbidden(msg)` from `../errors.js`.
- **Imports use `.js` extensions** even for `.ts` sources (ESM + NodeNext).
- **Tests:** Vitest, files at `apps/api/test/<name>.test.ts`, importing from `../src/…js`. Prefer pure functions tested without DB or network. Run with `npm --workspace apps/api run test`.
- **Feature flag:** all Phase 2 provisioning behaviour is dark unless `M365_PROV_ENABLED=true`.
- **Cloud PC ordering (hard):** `assign_licenses` MUST complete before `assign_cloudpc`. An unlicensed user added to the policy group yields a Cloud PC that silently never builds.
- **PII:** sensitive answers never enter `tickets.custom_fields`, notification payloads, or outbound webhooks.

## File Structure

**Phase 1**
- Create `apps/api/src/db/migrations/0053_onboarding_forms_pii.sql` — forms columns, `email`/`phone` types, `ticket_sensitive_fields`, `pii.view`, SBS field seed.
- Modify `apps/api/src/modules/forms.ts` — `FieldType`, `isFieldVisible`, validation.
- Create `apps/api/src/modules/sensitive-fields.ts` — write/read/purge of PII answers.
- Modify `apps/api/src/http/routes.ts` — sensitive-fields endpoint.
- Modify `apps/api/src/jobs/retention-purge.ts` — purge PII on ticket closure.
- Create `apps/web/components/dynamic-form-field.tsx` — extracted field renderer.
- Modify `apps/web/app/(app)/catalog/page.tsx` — use the component.

**Phase 2**
- Modify `apps/api/src/integrations/m365/graph-client.ts` — `PATCH`, `apiVersion`.
- Modify `apps/api/src/config.ts` — `parseProvisioningConfig`.
- Create `apps/api/src/integrations/m365/provisioning-graph.ts` — tenant reads/writes.
- Create `apps/api/src/modules/provisioning/planner.ts` — pure `planRun`.
- Create `apps/api/src/modules/provisioning/executor.ts` — step execution.
- Create `apps/api/src/db/migrations/0054_provisioning_runs.sql`.
- Create `apps/api/src/jobs/cloudpc-poller.ts`.
- Modify `apps/api/src/http/routes.ts` — provisioning endpoints.
- Create `apps/web/components/provisioning-panel.tsx`.

---

# Phase 1 — Intake

## Task 1: Forms subsystem columns and new field types

**Files:**
- Create: `apps/api/src/db/migrations/0053_onboarding_forms_pii.sql`
- Modify: `apps/api/src/modules/forms.ts:10-21`
- Test: `apps/api/test/forms.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FieldType` now includes `'email' | 'phone'`; `FormField` gains `visible_when: VisibleWhen | null`, `sensitive: boolean`, `options_source: string | null`. `VisibleWhen = { field: string; equals: string } | { field: string; in: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/forms.test.ts — append
import { validateAgainstForm } from '../src/modules/forms.js';

const base = { required: true, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null };

describe('email and phone field types', () => {
  it('rejects a malformed email and accepts a valid one', () => {
    const fields = [{ key: 'personal_email', label: 'Personal email', data_type: 'email' as const, ...base }];
    expect(validateAgainstForm(fields, { personal_email: 'nope' }).ok).toBe(false);
    expect(validateAgainstForm(fields, { personal_email: 'a@b.gov' }).ok).toBe(true);
  });

  it('accepts common phone formats and rejects letters', () => {
    const fields = [{ key: 'cell_phone', label: 'Cell', data_type: 'phone' as const, ...base }];
    expect(validateAgainstForm(fields, { cell_phone: '(555) 123-4567' }).ok).toBe(true);
    expect(validateAgainstForm(fields, { cell_phone: 'call me' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- forms`
Expected: FAIL — `email` is not an accepted `data_type`.

- [ ] **Step 3: Extend the types and validation in `forms.ts`**

```ts
export type FieldType =
  | 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date'
  | 'user' | 'user_multi' | 'attachment'
  | 'email' | 'phone';

export type VisibleWhen = { field: string; equals: string } | { field: string; in: string[] };

export interface FormField {
  key: string;
  label: string;
  data_type: FieldType;
  required: boolean;
  options: string[];
  maps_to: string | null;
  visible_when: VisibleWhen | null;
  sensitive: boolean;
  options_source: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+()\-.\s\d]{7,}$/;
```

In `validateAgainstForm`'s per-field switch, add:

```ts
case 'email':
  if (typeof value !== 'string' || !EMAIL.test(value)) {
    errors.push({ field: f.key, message: 'must be a valid email address' });
  }
  break;
case 'phone':
  if (typeof value !== 'string' || !PHONE.test(value)) {
    errors.push({ field: f.key, message: 'must be a valid phone number' });
  }
  break;
```

- [ ] **Step 4: Write the migration**

```sql
-- apps/api/src/db/migrations/0053_onboarding_forms_pii.sql
-- Part A: forms subsystem — conditional visibility, sensitive fields, server-sourced options.
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS visible_when jsonb;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS options_source text;

ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN ('text','textarea','number','select','checkbox','date',
                       'user','user_multi','attachment','email','phone'));
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm --workspace apps/api run test -- forms && npm run typecheck`
Expected: PASS. Fix any call site that constructs a `FormField` literal without the three new properties.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/migrations/0053_onboarding_forms_pii.sql apps/api/src/modules/forms.ts apps/api/test/forms.test.ts
git commit -m "feat(forms): email/phone field types + visible_when, sensitive, options_source columns"
```

---

## Task 2: Conditional field visibility

**Files:**
- Modify: `apps/api/src/modules/forms.ts`
- Test: `apps/api/test/forms.test.ts`

**Interfaces:**
- Consumes: `FormField`, `VisibleWhen` from Task 1.
- Produces: `isFieldVisible(field: FormField, answers: Record<string, unknown>): boolean`. `validateAgainstForm` skips validation for invisible fields.

- [ ] **Step 1: Write the failing test**

```ts
describe('isFieldVisible / conditional required', () => {
  const endDate = {
    key: 'end_date', label: 'End date', data_type: 'date' as const, required: true,
    options: [], maps_to: null, sensitive: false, options_source: null,
    visible_when: { field: 'access_type', equals: 'Temporary' },
  };
  const accessType = {
    key: 'access_type', label: 'Access type', data_type: 'select' as const, required: true,
    options: ['Permanent', 'Temporary'], maps_to: null, visible_when: null,
    sensitive: false, options_source: null,
  };

  it('does not require a hidden field', () => {
    const r = validateAgainstForm([accessType, endDate], { access_type: 'Permanent' });
    expect(r.ok).toBe(true);
  });

  it('requires the field once its condition is met', () => {
    const r = validateAgainstForm([accessType, endDate], { access_type: 'Temporary' });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toContain('end_date');
  });

  it('supports an "in" condition', () => {
    const addr = { ...endDate, key: 'home_address_street', data_type: 'text' as const,
      visible_when: { field: 'work_location', in: ['WFH-Permanent', 'WFH-Temporary'] } };
    expect(validateAgainstForm([addr], { work_location: 'On Site' }).ok).toBe(true);
    expect(validateAgainstForm([addr], { work_location: 'WFH-Permanent' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- forms`
Expected: FAIL — hidden `end_date` is still reported as required.

- [ ] **Step 3: Implement**

```ts
/** Is this field shown, given the current answers? Fields with no condition are always shown. */
export function isFieldVisible(field: FormField, answers: Record<string, unknown>): boolean {
  const cond = field.visible_when;
  if (!cond) return true;
  const actual = answers[cond.field];
  if (typeof actual !== 'string') return false;
  return 'equals' in cond ? actual === cond.equals : cond.in.includes(actual);
}
```

In `validateAgainstForm`, before validating each field:

```ts
if (!isFieldVisible(f, answers)) continue;
```

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- forms`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/forms.ts apps/api/test/forms.test.ts
git commit -m "feat(forms): conditional field visibility via visible_when"
```

---

## Task 3: Sensitive-field storage, permission, and audited read

**Files:**
- Modify: `apps/api/src/db/migrations/0053_onboarding_forms_pii.sql`
- Create: `apps/api/src/modules/sensitive-fields.ts`
- Test: `apps/api/test/sensitive-fields.test.ts`

**Interfaces:**
- Consumes: `isFieldVisible`, `FormField` from Tasks 1-2.
- Produces:
  - `splitSensitiveAnswers(fields: FormField[], answers: Record<string, unknown>): { normal: Record<string, unknown>; sensitive: Record<string, unknown> }` — pure.
  - `storeSensitive(ticketId: string, orgId: string, values: Record<string, unknown>): Promise<void>`
  - `readSensitive(actor: Principal, ticketId: string): Promise<Record<string, string>>` — authorizes `pii.view` and writes an audit row.
  - `MASK = '••••'`

- [ ] **Step 1: Write the failing test (pure split only)**

```ts
// apps/api/test/sensitive-fields.test.ts
import { describe, it, expect } from 'vitest';
import { splitSensitiveAnswers } from '../src/modules/sensitive-fields.js';

const f = (key: string, sensitive: boolean) => ({
  key, label: key, data_type: 'text' as const, required: false, options: [],
  maps_to: null, visible_when: null, sensitive, options_source: null,
});

describe('splitSensitiveAnswers', () => {
  it('routes sensitive answers away from the normal bag', () => {
    const fields = [f('job_title', false), f('cell_phone', true)];
    const out = splitSensitiveAnswers(fields, { job_title: 'Analyst', cell_phone: '555-0100' });
    expect(out.normal).toEqual({ job_title: 'Analyst' });
    expect(out.sensitive).toEqual({ cell_phone: '555-0100' });
  });

  it('ignores answers for fields the form does not declare', () => {
    const out = splitSensitiveAnswers([f('job_title', false)], { job_title: 'A', injected: 'x' });
    expect(out.normal).toEqual({ job_title: 'A' });
    expect(out.sensitive).toEqual({});
  });

  it('drops sensitive answers whose field is not visible', () => {
    const hidden = { ...f('home_address_street', true),
      visible_when: { field: 'work_location', in: ['WFH-Permanent'] } };
    const out = splitSensitiveAnswers([hidden], { work_location: 'On Site', home_address_street: '1 Main St' });
    expect(out.sensitive).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- sensitive-fields`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Extend the migration**

```sql
-- Part A (continued): PII storage, held apart from tickets.custom_fields so it never
-- rides along on ticket reads, notification payloads, or outbound webhooks.
CREATE TABLE IF NOT EXISTS ticket_sensitive_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, key)
);

ALTER TABLE ticket_sensitive_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_sensitive_fields_isolation ON ticket_sensitive_fields;
CREATE POLICY ticket_sensitive_fields_isolation ON ticket_sensitive_fields
  USING (organization_id = app_org_id() OR app_all_orgs());

INSERT INTO permissions (key, category, description) VALUES
  ('pii.view', 'ticketing', 'View personally identifiable information captured on onboarding requests')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'pii.view' FROM roles r WHERE r.key IN ('SuperAdmin', 'ServiceDeskManager')
ON CONFLICT DO NOTHING;
```

> Confirm `app_all_orgs()` is the helper used by sibling policies; if the codebase spells it differently, mirror the existing `_isolation` policy on `api_keys` verbatim.

- [ ] **Step 4: Implement the module**

```ts
// apps/api/src/modules/sensitive-fields.ts
// PII captured on onboarding requests. Held apart from tickets.custom_fields so it is never
// serialized onto ticket reads, notification payloads, or outbound webhooks. Reads require
// `pii.view` and are individually audited; rows are purged when the ticket closes.
import { withSystemContext } from '../db/pool.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { isFieldVisible, type FormField } from './forms.js';
import type { Principal } from '../types.js';

export const MASK = '••••';

/** Split answers into the normal bag and the sensitive bag. Pure. Unknown or
 *  currently-hidden fields are dropped entirely. */
export function splitSensitiveAnswers(
  fields: FormField[],
  answers: Record<string, unknown>,
): { normal: Record<string, unknown>; sensitive: Record<string, unknown> } {
  const normal: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.key in answers)) continue;
    if (!isFieldVisible(f, answers)) continue;
    (f.sensitive ? sensitive : normal)[f.key] = answers[f.key];
  }
  return { normal, sensitive };
}

export async function storeSensitive(
  ticketId: string,
  organizationId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return;
  await withSystemContext(async (sql) => {
    for (const [key, value] of entries) {
      await sql.query(
        `INSERT INTO ticket_sensitive_fields (ticket_id, organization_id, key, value)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (ticket_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [ticketId, organizationId, key, String(value)],
      );
    }
  });
}

/** Read PII for a ticket. Requires `pii.view`; every access is audited. */
export async function readSensitive(actor: Principal, ticketId: string): Promise<Record<string, string>> {
  const row = await withSystemContext(async (sql) => {
    const { rows } = await sql.query('SELECT organization_id FROM tickets WHERE id = $1', [ticketId]);
    return rows[0];
  });
  if (!row) return {};
  authorize(actor, 'pii.view', { organizationId: row.organization_id });

  const out = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT key, value FROM ticket_sensitive_fields WHERE ticket_id = $1 ORDER BY key',
      [ticketId],
    );
    return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  });

  await audit(actor, {
    action: 'pii.viewed',
    organizationId: row.organization_id,
    resourceType: 'ticket',
    resourceId: ticketId,
    detail: { keys: Object.keys(out) },
  });
  return out;
}

/** Engine-side read: no actor, no permission check, no audit-as-user. System context only. */
export async function readSensitiveForEngine(ticketId: string): Promise<Record<string, string>> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT key, value FROM ticket_sensitive_fields WHERE ticket_id = $1',
      [ticketId],
    );
    return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npm --workspace apps/api run test -- sensitive-fields && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/migrations/0053_onboarding_forms_pii.sql apps/api/src/modules/sensitive-fields.ts apps/api/test/sensitive-fields.test.ts
git commit -m "feat(pii): sensitive-field storage with pii.view permission and audited reads"
```

---

## Task 4: Route sensitive answers on submit, and expose the audited read

**Files:**
- Modify: `apps/api/src/modules/forms.ts` (`submitAnswers`, ~line 205)
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/form-mapping.test.ts`

**Interfaces:**
- Consumes: `splitSensitiveAnswers`, `storeSensitive`, `readSensitive` from Task 3.
- Produces: `GET /api/v1/tickets/:id/sensitive` → `{ data: Record<string,string> }`. `submitAnswers` writes only non-sensitive answers into `tickets.custom_fields`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/form-mapping.test.ts — append
import { splitSensitiveAnswers } from '../src/modules/sensitive-fields.js';

it('custom_fields never receives a sensitive answer', () => {
  const fields = [
    { key: 'job_title', label: 'Job title', data_type: 'text' as const, required: false, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null },
    { key: 'personal_email', label: 'Personal email', data_type: 'email' as const, required: false, options: [], maps_to: null, visible_when: null, sensitive: true, options_source: null },
  ];
  const { normal } = splitSensitiveAnswers(fields, { job_title: 'Analyst', personal_email: 'a@b.com' });
  expect(Object.keys(normal)).not.toContain('personal_email');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- form-mapping`
Expected: FAIL until the import resolves and `submitAnswers` is updated.

- [ ] **Step 3: Update `submitAnswers`**

Inside `submitAnswers`, after the form's fields are loaded and validation passes, replace the direct merge into `custom_fields` with:

```ts
const { normal, sensitive } = splitSensitiveAnswers(fields, answers);
// …existing merge, but using `normal` instead of `answers`…
await storeSensitive(ticketId, organizationId, sensitive);
```

- [ ] **Step 4: Add the route**

In `routes.ts`, beside the other ticket sub-resources:

```ts
app.get('/api/v1/tickets/:id/sensitive', async (req) => {
  const p = principal(req);
  const { id } = req.params as { id: string };
  return { data: await sensitiveFields.readSensitive(p, id) };
});
```

with `import * as sensitiveFields from '../modules/sensitive-fields.js';` at the top.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm --workspace apps/api run test && npm run typecheck`
Expected: PASS, full suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/forms.ts apps/api/src/http/routes.ts apps/api/test/form-mapping.test.ts
git commit -m "feat(pii): route sensitive answers out of custom_fields; add audited read endpoint"
```

---

## Task 5: Purge PII on ticket closure

**Files:**
- Modify: `apps/api/src/jobs/retention-purge.ts`
- Test: `apps/api/test/retention-purge.test.ts`

**Interfaces:**
- Consumes: `ticket_sensitive_fields` from Task 3.
- Produces: `sensitivePurgeSql(): string` — the exported SQL predicate, so the sweep is testable without a database.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/retention-purge.test.ts
import { describe, it, expect } from 'vitest';
import { sensitivePurgeSql } from '../src/jobs/retention-purge.js';

describe('sensitivePurgeSql', () => {
  it('targets only closed or resolved tickets', () => {
    const sql = sensitivePurgeSql();
    expect(sql).toContain('ticket_sensitive_fields');
    expect(sql).toMatch(/status IN \('resolved','closed'\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- retention-purge`
Expected: FAIL — `sensitivePurgeSql` is not exported.

- [ ] **Step 3: Implement**

Add to `retention-purge.ts`:

```ts
/** PII is retained only for the duration of fulfillment: once the ticket reaches a terminal
 *  status the captured values are deleted, leaving the audit trail as the only record that
 *  they ever existed. */
export function sensitivePurgeSql(): string {
  return `DELETE FROM ticket_sensitive_fields
          WHERE ticket_id IN (
            SELECT id FROM tickets WHERE status IN ('resolved','closed')
          )`;
}
```

and inside the existing `tick`'s transaction, before `COMMIT`:

```ts
const pii = await sql.query(sensitivePurgeSql());
if (pii.rowCount) logger.info({ purged: pii.rowCount }, 'purged ticket PII');
```

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- retention-purge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/retention-purge.ts apps/api/test/retention-purge.test.ts
git commit -m "feat(pii): purge sensitive onboarding fields once the ticket closes"
```

---

## Task 6: Seed the SBS form fields

**Files:**
- Modify: `apps/api/src/db/migrations/0053_onboarding_forms_pii.sql`
- Modify: `apps/api/src/db/seed.ts` (mirror the field set — see the dual-write rule below)

**Interfaces:**
- Consumes: columns from Task 1.
- Produces: the `user_onboarding` form carrying every SBS field. Downstream tasks read `legal_first_name`, `legal_last_name`, `preferred_first_name`, `cloud_pc_policy`, `license_bundle`, `security_groups`, `supervisor`.

> **Dual-write rule (project convention):** seeded form/KB content must be changed in **both** `seed.ts` and an idempotent migration, or a fresh `db:seed` will silently revert the migration.

- [ ] **Step 1: Append the field seed to the migration**

```sql
-- Part B: SBS "New User Computer/Network Access Form" fields.
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='user_onboarding' AND organization_id IS NULL;
  IF f IS NULL THEN RAISE NOTICE 'user_onboarding form missing; 0037 must run first'; RETURN; END IF;

  -- The single free-text name is superseded by split legal-name fields.
  DELETE FROM form_fields WHERE form_id=f AND key='new_employee_name';

  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to,visible_when,sensitive,options_source) VALUES
    (f,'legal_last_name','Legal last name','text',true,'[]',1,NULL,NULL,false,NULL),
    (f,'legal_first_name','Legal first name','text',true,'[]',2,'subject',NULL,false,NULL),
    (f,'middle_name','Middle name','text',false,'[]',3,NULL,NULL,false,NULL),
    (f,'preferred_first_name','Preferred first name','text',false,'[]',4,NULL,NULL,false,NULL),
    (f,'access_type','Access type','select',true,'["Permanent","Temporary"]',5,NULL,NULL,false,NULL),
    (f,'hire_type','Hire type','select',true,'["Direct Hire","Temporary","Consultant"]',6,NULL,NULL,false,NULL),
    (f,'employee_id','Employee ID','text',false,'[]',7,NULL,NULL,false,NULL),
    (f,'request_kind','Request kind','select',true,'["New Hire","Replacement"]',8,NULL,NULL,false,NULL),
    (f,'replacement_for','Replacement for','user',false,'[]',9,NULL,'{"field":"request_kind","equals":"Replacement"}',false,NULL),
    (f,'end_date','End date','date',true,'[]',10,NULL,'{"field":"access_type","equals":"Temporary"}',false,NULL),
    (f,'supervisor','Supervisor','user',true,'[]',11,'manager',NULL,false,NULL),
    (f,'work_location','Work location','select',true,'["Work from Home - Permanent","Work from Home - Temporary","On Site"]',12,NULL,NULL,false,NULL),
    (f,'duty_location','Duty location','text',false,'[]',13,NULL,NULL,false,NULL),
    (f,'email_account','Email account','select',true,'["Create New","Change Existing"]',14,NULL,NULL,false,NULL),
    (f,'cloud_pc_policy','Cloud PC provisioning policy','select',false,'[]',15,NULL,NULL,false,'cloudpc_policies'),
    (f,'personal_email','Personal email address','email',false,'[]',16,NULL,NULL,true,NULL),
    (f,'cell_phone','Cell phone number','phone',false,'[]',17,NULL,NULL,true,NULL),
    (f,'home_address_street','Home address (street)','text',false,'[]',18,NULL,'{"field":"work_location","in":["Work from Home - Permanent","Work from Home - Temporary"]}',true,NULL),
    (f,'home_address_csz','Home address (city, state, ZIP)','text',false,'[]',19,NULL,'{"field":"work_location","in":["Work from Home - Permanent","Work from Home - Temporary"]}',true,NULL)
  ON CONFLICT (form_id,key) DO UPDATE SET
    label=EXCLUDED.label, data_type=EXCLUDED.data_type, required=EXCLUDED.required,
    options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to,
    visible_when=EXCLUDED.visible_when, sensitive=EXCLUDED.sensitive,
    options_source=EXCLUDED.options_source;
END $$;
```

- [ ] **Step 2: Mirror the same field list in `seed.ts`**

Find where `seed.ts` references `new_user_provisioning` / `user_onboarding` and add the identical field rows, so a fresh seed produces the same form.

- [ ] **Step 3: Apply and verify against the dev database**

```bash
docker compose up -d db
npm --workspace apps/api run migrate -- --env-file ../../.env
psql "$DATABASE_URL" -c "SELECT key, data_type, sensitive, visible_when FROM form_fields WHERE form_id=(SELECT id FROM request_forms WHERE key='user_onboarding') ORDER BY position;"
```

Expected: 19 new rows present; `new_employee_name` absent; `sensitive=true` on exactly the four PII fields.

> The dev database is on host port **5544**, not 5432. Migrate/seed need `--env-file ../../.env` or they hit the wrong Postgres.

- [ ] **Step 4: Run migration twice to prove idempotency**

Run: `npm --workspace apps/api run migrate -- --env-file ../../.env`
Expected: succeeds with no error and no duplicate rows.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrations/0053_onboarding_forms_pii.sql apps/api/src/db/seed.ts
git commit -m "feat(forms): seed SBS new-user onboarding fields with conditional and sensitive flags"
```

---

## Task 7: Extract the dynamic field renderer and support the new behaviour

**Files:**
- Create: `apps/web/components/dynamic-form-field.tsx`
- Modify: `apps/web/app/(app)/catalog/page.tsx:164-180`

**Interfaces:**
- Consumes: field shape from the API (`data_type`, `visible_when`, `sensitive`, `options_source`).
- Produces: `<DynamicFormField field={…} value={…} answers={…} onChange={…} />` and `isFieldVisible(field, answers)` (client mirror of the server rule).

- [ ] **Step 1: Create the component**

```tsx
// apps/web/components/dynamic-form-field.tsx
'use client';

export type VisibleWhen = { field: string; equals: string } | { field: string; in: string[] };

export interface FormFieldDef {
  key: string;
  label: string;
  data_type: string;
  required: boolean;
  options: string[];
  visible_when: VisibleWhen | null;
  sensitive: boolean;
  options_source: string | null;
}

/** Mirrors the server rule in apps/api/src/modules/forms.ts — keep the two in step. */
export function isFieldVisible(field: FormFieldDef, answers: Record<string, unknown>): boolean {
  const cond = field.visible_when;
  if (!cond) return true;
  const actual = answers[cond.field];
  if (typeof actual !== 'string') return false;
  return 'equals' in cond ? actual === cond.equals : cond.in.includes(actual);
}

export function DynamicFormField({
  field, value, answers, options, onChange, renderUserPicker,
}: {
  field: FormFieldDef;
  value: unknown;
  answers: Record<string, unknown>;
  options: string[];
  onChange: (key: string, value: unknown) => void;
  renderUserPicker: (field: FormFieldDef, multi: boolean) => React.ReactNode;
}) {
  if (!isFieldVisible(field, answers)) return null;
  const set = (v: unknown) => onChange(field.key, v);
  const common = { id: field.key, required: field.required, className: 'w-full rounded border px-2 py-1' };

  return (
    <label htmlFor={field.key} className="block space-y-1">
      <span className="text-sm font-medium">
        {field.label}{field.required ? ' *' : ''}
        {field.sensitive ? <span className="ml-2 text-xs text-amber-600">sensitive</span> : null}
      </span>
      {field.data_type === 'textarea' ? (
        <textarea {...common} value={String(value ?? '')} onChange={(e) => set(e.target.value)} />
      ) : field.data_type === 'select' ? (
        <select {...common} value={String(value ?? '')} onChange={(e) => set(e.target.value)}>
          <option value="">Select…</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.data_type === 'checkbox' ? (
        <input id={field.key} type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
      ) : field.data_type === 'user' ? (
        renderUserPicker(field, false)
      ) : field.data_type === 'user_multi' ? (
        renderUserPicker(field, true)
      ) : (
        <input
          {...common}
          type={field.data_type === 'email' ? 'email' : field.data_type === 'phone' ? 'tel'
            : field.data_type === 'date' ? 'date' : field.data_type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </label>
  );
}
```

- [ ] **Step 2: Use it in the catalog page**

Replace the inline `data_type` switch with `<DynamicFormField …>`, passing the existing user-picker JSX through `renderUserPicker`. For a field with `options_source`, fetch its options once on mount from
`/api/v1/provisioning/cloud-pc-policies` and fall back to `field.options` on any error.

> **Ordering:** that endpoint does not exist until Task 15. This is intentional — the fallback
> means the field degrades to an empty select through all of Phase 1 rather than erroring, and
> starts populating the moment Phase 2 lands. Verify the fallback works by loading the catalog
> page now and confirming the form still renders with the endpoint 404ing.

- [ ] **Step 3: Verify the build**

Run: `npm --workspace apps/web run typecheck && (cd apps/web && NEXT_DIST_DIR=.next-verify npx next build)`
Expected: typecheck clean, build succeeds. Then `rm -rf apps/web/.next-verify`.

> Never run `next build` against the default `.next` while `next dev` is live — it corrupts the dev cache and yields 500s.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/dynamic-form-field.tsx "apps/web/app/(app)/catalog/page.tsx"
git commit -m "feat(web): extract DynamicFormField with conditional visibility and email/phone types"
```

---

**Phase 1 milestone.** The SBS form is fully captured, PII is protected and purged, nothing touches Microsoft Graph. This is independently shippable — deploy and confirm before starting Phase 2.

---

# Phase 2 — Provisioning

## Task 8: Graph client — PATCH and selectable API version

**Files:**
- Modify: `apps/api/src/integrations/m365/graph-client.ts:26-50`
- Test: `apps/api/test/graph-client.test.ts`

**Interfaces:**
- Produces: `GraphClientOptions` gains `apiVersion?: 'v1.0' | 'beta'` (default `'v1.0'`); `GraphClient` gains `patch(path, body)`. Existing `get`/`post` signatures unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/graph-client.test.ts
import { describe, it, expect } from 'vitest';
import { createGraphClient } from '../src/integrations/m365/graph-client.js';

function fakeFetch(seen: { url: string; method: string }[]) {
  return async (url: string, init: Record<string, unknown>) => {
    seen.push({ url, method: String(init.method) });
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => '' };
  };
}

describe('graph client', () => {
  it('issues PATCH requests', async () => {
    const seen: { url: string; method: string }[] = [];
    const c = createGraphClient({ graphEndpoint: 'https://graph.microsoft.us', getToken: async () => 't', fetchImpl: fakeFetch(seen) as never });
    await c.patch('/users/abc', { jobTitle: 'Analyst' });
    expect(seen[0].method).toBe('PATCH');
    expect(seen[0].url).toBe('https://graph.microsoft.us/v1.0/users/abc');
  });

  it('honours an explicit apiVersion', async () => {
    const seen: { url: string; method: string }[] = [];
    const c = createGraphClient({ graphEndpoint: 'https://graph.microsoft.us', getToken: async () => 't', fetchImpl: fakeFetch(seen) as never, apiVersion: 'beta' });
    await c.get('/deviceManagement/virtualEndpoint/provisioningPolicies');
    expect(seen[0].url).toContain('/beta/deviceManagement');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- graph-client`
Expected: FAIL — `patch` is not a function.

- [ ] **Step 3: Implement**

```ts
export interface GraphClientOptions {
  graphEndpoint: string;
  getToken: () => Promise<string>;
  fetchImpl: FetchWithHeaders | FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  apiVersion?: 'v1.0' | 'beta';
}

export interface GraphClient {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
  patch: (path: string, body: unknown) => Promise<any>;
}
```

Widen the internal signature to `method: 'GET' | 'POST' | 'PATCH'`, build the URL with
`const version = opts.apiVersion ?? 'v1.0';` → `${opts.graphEndpoint}/${version}${path}`, and
return `{ get, post, patch }`. The existing 429/503 backoff is untouched.

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- graph-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/m365/graph-client.ts apps/api/test/graph-client.test.ts
git commit -m "feat(graph): add PATCH verb and selectable API version"
```

---

## Task 9: Provisioning configuration

**Files:**
- Modify: `apps/api/src/config.ts`
- Test: `apps/api/test/provisioning-config.test.ts`

**Interfaces:**
- Produces: `ProvisioningConfig { enabled, tenantId, clientId, clientSecret, cloud, upnDomain, baselineSkus: string[], cloudPcPolicy }` and `parseProvisioningConfig(env)`. Exposed as `config.provisioning`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/provisioning-config.test.ts
import { describe, it, expect } from 'vitest';
import { parseProvisioningConfig } from '../src/config.js';

describe('parseProvisioningConfig', () => {
  it('is disabled without explicit opt-in', () => {
    expect(parseProvisioningConfig({}).enabled).toBe(false);
  });

  it('splits the baseline SKU list and trims blanks', () => {
    const c = parseProvisioningConfig({ M365_PROV_BASELINE_SKUS: 'SPE_E3_USGOV_GCCHIGH, MDATP_XPLAT ,' });
    expect(c.baselineSkus).toEqual(['SPE_E3_USGOV_GCCHIGH', 'MDATP_XPLAT']);
  });

  it('refuses to report enabled when required settings are missing', () => {
    expect(parseProvisioningConfig({ M365_PROV_ENABLED: 'true' }).enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- provisioning-config`
Expected: FAIL — `parseProvisioningConfig` is not exported.

- [ ] **Step 3: Implement, beside `parseM365Config`**

```ts
export interface ProvisioningConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  cloud: M365Cloud;
  upnDomain: string;
  baselineSkus: string[];
  cloudPcPolicy: string;
}

export function parseProvisioningConfig(env: NodeJS.ProcessEnv): ProvisioningConfig {
  const tenantId = env.M365_PROV_TENANT_ID ?? '';
  const clientId = env.M365_PROV_CLIENT_ID ?? '';
  const clientSecret = env.M365_PROV_CLIENT_SECRET ?? '';
  const upnDomain = (env.M365_PROV_UPN_DOMAIN ?? '').toLowerCase();
  const baselineSkus = (env.M365_PROV_BASELINE_SKUS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Opting in is necessary but not sufficient: a half-configured app must stay dark.
  const enabled = bool(env.M365_PROV_ENABLED) && Boolean(tenantId && clientId && clientSecret && upnDomain);
  return {
    enabled, tenantId, clientId, clientSecret,
    cloud: (env.M365_PROV_CLOUD as M365Cloud) ?? 'gcchigh',
    upnDomain, baselineSkus,
    cloudPcPolicy: env.M365_PROV_CLOUDPC_POLICY ?? 'SBSFederal Cloud PC',
  };
}
```

and add `provisioning: parseProvisioningConfig(process.env),` to the exported `config` object.

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- provisioning-config && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/test/provisioning-config.test.ts
git commit -m "feat(provisioning): configuration parsed from M365_PROV_* env"
```

---

## Task 10: Provisioning Graph adapter

**Files:**
- Create: `apps/api/src/integrations/m365/provisioning-graph.ts`
- Test: `apps/api/test/provisioning-graph.test.ts`

**Interfaces:**
- Consumes: `createGraphClient` (Task 8), `config.provisioning` (Task 9), `createTokenProvider`.
- Produces:
  - `TenantState { skus: SubscribedSku[]; policies: CloudPcPolicy[]; }`
  - `SubscribedSku { skuId: string; skuPartNumber: string; enabled: number; consumed: number }`
  - `CloudPcPolicy { id: string; displayName: string; groupIds: string[] }`
  - `readTenantState(g: GraphClient, policyBeta: GraphClient): Promise<TenantState>`
  - `findUserByUpn(g, upn): Promise<{ id: string; userPrincipalName: string } | null>`
  - `directoryRoleCount(g, userId): Promise<number>`
  - `createUser(g, body)`, `assignLicenses(g, userId, skuIds)`, `addToGroup(g, groupId, userId)`, `issueTap(g, userId)`, `getCloudPcStatus(g, userId)`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/provisioning-graph.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeSkus, normalizePolicies } from '../src/integrations/m365/provisioning-graph.js';

describe('normalizeSkus', () => {
  it('projects the seat counts used for availability checks', () => {
    const out = normalizeSkus({ value: [
      { skuId: 'a', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', prepaidUnits: { enabled: 10 }, consumedUnits: 7 },
    ] });
    expect(out).toEqual([{ skuId: 'a', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 10, consumed: 7 }]);
  });

  it('tolerates a missing prepaidUnits block', () => {
    expect(normalizeSkus({ value: [{ skuId: 'b', skuPartNumber: 'X' }] }))
      .toEqual([{ skuId: 'b', skuPartNumber: 'X', enabled: 0, consumed: 0 }]);
  });
});

describe('normalizePolicies', () => {
  it('extracts assignment group ids', () => {
    const out = normalizePolicies({ value: [{
      id: 'p1', displayName: 'SBSFederal Cloud PC',
      assignments: [{ target: { groupId: 'g1' } }, { target: { groupId: 'g2' } }],
    }] });
    expect(out).toEqual([{ id: 'p1', displayName: 'SBSFederal Cloud PC', groupIds: ['g1', 'g2'] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- provisioning-graph`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/integrations/m365/provisioning-graph.ts
// Graph operations for user provisioning against the SBS Federal tenant. Pure normalizers are
// exported separately so the planner can be tested with no network.
import type { GraphClient } from './graph-client.js';

export interface SubscribedSku { skuId: string; skuPartNumber: string; enabled: number; consumed: number }
export interface CloudPcPolicy { id: string; displayName: string; groupIds: string[] }
export interface TenantState { skus: SubscribedSku[]; policies: CloudPcPolicy[] }

export function normalizeSkus(res: any): SubscribedSku[] {
  return (res?.value ?? []).map((s: any) => ({
    skuId: s.skuId,
    skuPartNumber: s.skuPartNumber,
    enabled: s.prepaidUnits?.enabled ?? 0,
    consumed: s.consumedUnits ?? 0,
  }));
}

export function normalizePolicies(res: any): CloudPcPolicy[] {
  return (res?.value ?? []).map((p: any) => ({
    id: p.id,
    displayName: p.displayName,
    groupIds: (p.assignments ?? []).map((a: any) => a?.target?.groupId).filter(Boolean),
  }));
}

export async function readTenantState(g: GraphClient, policyClient: GraphClient): Promise<TenantState> {
  const [skus, policies] = await Promise.all([
    g.get('/subscribedSkus'),
    policyClient.get('/deviceManagement/virtualEndpoint/provisioningPolicies?$expand=assignments'),
  ]);
  return { skus: normalizeSkus(skus), policies: normalizePolicies(policies) };
}

export async function findUserByUpn(g: GraphClient, upn: string) {
  const res = await g.get(`/users?$filter=userPrincipalName eq '${encodeURIComponent(upn)}'&$select=id,userPrincipalName`);
  return res?.value?.[0] ?? null;
}

/** Non-zero means the account holds a directory role — never adopt or modify it. */
export async function directoryRoleCount(g: GraphClient, userId: string): Promise<number> {
  const res = await g.get(`/users/${userId}/memberOf/microsoft.graph.directoryRole?$select=id`);
  return (res?.value ?? []).length;
}

export async function createUser(g: GraphClient, body: Record<string, unknown>) {
  return g.post('/users', body);
}

export async function assignLicenses(g: GraphClient, userId: string, skuIds: string[]) {
  return g.post(`/users/${userId}/assignLicense`, {
    addLicenses: skuIds.map((skuId) => ({ skuId, disabledPlans: [] })),
    removeLicenses: [],
  });
}

export async function userLicenseSkuIds(g: GraphClient, userId: string): Promise<string[]> {
  const res = await g.get(`/users/${userId}/licenseDetails?$select=skuId`);
  return (res?.value ?? []).map((l: any) => l.skuId);
}

export async function addToGroup(g: GraphClient, groupId: string, userId: string) {
  return g.post(`/groups/${groupId}/members/$ref`, {
    '@odata.id': `https://graph.microsoft.us/v1.0/directoryObjects/${userId}`,
  });
}

export async function issueTap(g: GraphClient, userId: string) {
  return g.post(`/users/${userId}/authentication/temporaryAccessPassMethods`, {
    isUsableOnce: true, lifetimeInMinutes: 480,
  });
}

export async function getCloudPcStatus(g: GraphClient, userId: string): Promise<string | null> {
  const res = await g.get(`/deviceManagement/virtualEndpoint/cloudPCs?$filter=userPrincipalName eq '${userId}'`);
  return res?.value?.[0]?.status ?? null;
}
```

> The `@odata.id` host in `addToGroup` must match the GCC High Graph endpoint. Derive it from
> `config.provisioning` rather than hardcoding if the tenant's endpoint differs.

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- provisioning-graph && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/m365/provisioning-graph.ts apps/api/test/provisioning-graph.test.ts
git commit -m "feat(provisioning): Graph adapter for users, licenses, groups, TAP, Cloud PC"
```

---

## Task 11: The pure planner

**Files:**
- Create: `apps/api/src/modules/provisioning/planner.ts`
- Test: `apps/api/test/provisioning-planner.test.ts`

**Interfaces:**
- Consumes: `TenantState`, `SubscribedSku`, `CloudPcPolicy` (Task 10).
- Produces:
  - `PlanStep { key: StepKey; label: string; detail: Record<string, unknown> }`
  - `StepKey = 'create_user' | 'assign_licenses' | 'add_groups' | 'assign_cloudpc' | 'issue_tap' | 'await_cloudpc'`
  - `Blocker { code: string; message: string }`
  - `Plan { upn: string; displayName: string; steps: PlanStep[]; blockers: Blocker[] }`
  - `deriveUpn(answers, upnDomain): string`
  - `planRun(input: PlanInput): Plan` — pure, no I/O.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/provisioning-planner.test.ts
import { describe, it, expect } from 'vitest';
import { deriveUpn, planRun } from '../src/modules/provisioning/planner.js';

const tenant = {
  skus: [
    { skuId: 'e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 10, consumed: 2 },
    { skuId: 'mde', skuPartNumber: 'MDATP_XPLAT', enabled: 10, consumed: 2 },
  ],
  policies: [{ id: 'p1', displayName: 'SBSFederal Cloud PC', groupIds: ['g-cloudpc'] }],
};

const answers = {
  legal_first_name: 'Ada', legal_last_name: 'Lovelace',
  work_location: 'On Site', cloud_pc_policy: 'SBSFederal Cloud PC',
  security_groups: 'All Staff', supervisor: 'sup-1',
};

const base = {
  answers, tenant, upnDomain: 'sbsfederal.com',
  baselineSkus: ['SPE_E3_USGOV_GCCHIGH', 'MDATP_XPLAT'],
  existingUser: null, existingRoleCount: 0,
};

describe('deriveUpn', () => {
  it('builds first.last at the configured domain, lowercased', () => {
    expect(deriveUpn(answers, 'sbsfederal.com')).toBe('ada.lovelace@sbsfederal.com');
  });
  it('prefers the preferred first name when present', () => {
    expect(deriveUpn({ ...answers, preferred_first_name: 'Addy' }, 'sbsfederal.com'))
      .toBe('addy.lovelace@sbsfederal.com');
  });
  it('strips characters that are invalid in a UPN', () => {
    expect(deriveUpn({ legal_first_name: "D'Arcy", legal_last_name: 'Van Berg' }, 'sbsfederal.com'))
      .toBe('darcy.vanberg@sbsfederal.com');
  });
});

describe('planRun', () => {
  it('orders licences before the Cloud PC group assignment', () => {
    const keys = planRun(base).steps.map((s) => s.key);
    expect(keys.indexOf('assign_licenses')).toBeLessThan(keys.indexOf('assign_cloudpc'));
    expect(keys).toContain('await_cloudpc');
  });

  it('has no blockers for a clean request', () => {
    expect(planRun(base).blockers).toEqual([]);
  });

  it('blocks when a baseline SKU is absent from the tenant', () => {
    const p = planRun({ ...base, baselineSkus: ['SPE_E3_USGOV_GCCHIGH', 'NOT_PRESENT'] });
    expect(p.blockers.map((b) => b.code)).toContain('sku_missing');
  });

  it('blocks when a baseline SKU has no seats left', () => {
    const p = planRun({ ...base, tenant: { ...tenant,
      skus: [{ skuId: 'e3', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 2, consumed: 2 },
             { skuId: 'mde', skuPartNumber: 'MDATP_XPLAT', enabled: 10, consumed: 2 }] } });
    expect(p.blockers.map((b) => b.code)).toContain('no_seats');
  });

  it('blocks when the named Cloud PC policy does not exist', () => {
    const p = planRun({ ...base, answers: { ...answers, cloud_pc_policy: 'Nope' } });
    expect(p.blockers.map((b) => b.code)).toContain('policy_missing');
  });

  it('blocks when the UPN belongs to a privileged account', () => {
    const p = planRun({ ...base, existingUser: { id: 'u1', userPrincipalName: 'ada.lovelace@sbsfederal.com' }, existingRoleCount: 1 });
    expect(p.blockers.map((b) => b.code)).toContain('privileged_account');
  });

  it('omits Cloud PC steps when no policy was requested', () => {
    const p = planRun({ ...base, answers: { ...answers, cloud_pc_policy: '' } });
    expect(p.steps.map((s) => s.key)).not.toContain('assign_cloudpc');
    expect(p.steps.map((s) => s.key)).not.toContain('await_cloudpc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- provisioning-planner`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/provisioning/planner.ts
// Pure planner. The dry-run preview and the executor walk the SAME plan, so what the admin
// approves is exactly what runs. No I/O here — everything the plan needs is passed in.
import type { TenantState } from '../../integrations/m365/provisioning-graph.js';

export type StepKey =
  | 'create_user' | 'assign_licenses' | 'add_groups'
  | 'assign_cloudpc' | 'issue_tap' | 'await_cloudpc';

export interface PlanStep { key: StepKey; label: string; detail: Record<string, unknown> }
export interface Blocker { code: string; message: string }
export interface Plan { upn: string; displayName: string; steps: PlanStep[]; blockers: Blocker[] }

export interface PlanInput {
  answers: Record<string, unknown>;
  tenant: TenantState;
  upnDomain: string;
  baselineSkus: string[];
  existingUser: { id: string; userPrincipalName: string } | null;
  existingRoleCount: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
/** UPN-safe: letters and digits only, so apostrophes and spaces cannot break the address. */
const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

export function deriveUpn(answers: Record<string, unknown>, upnDomain: string): string {
  const first = slug(str(answers.preferred_first_name) || str(answers.legal_first_name));
  const last = slug(str(answers.legal_last_name));
  return `${first}.${last}@${upnDomain}`;
}

export function planRun(input: PlanInput): Plan {
  const { answers, tenant, upnDomain, baselineSkus, existingUser, existingRoleCount } = input;
  const blockers: Blocker[] = [];
  const upn = deriveUpn(answers, upnDomain);
  const first = str(answers.preferred_first_name) || str(answers.legal_first_name);
  const displayName = [first, str(answers.legal_last_name)].filter(Boolean).join(' ');

  if (!str(answers.legal_first_name) || !str(answers.legal_last_name)) {
    blockers.push({ code: 'name_missing', message: 'Legal first and last name are required.' });
  }
  if (!upn.endsWith(`@${upnDomain}`)) {
    blockers.push({ code: 'upn_domain', message: `UPN must be under @${upnDomain}.` });
  }
  if (existingUser && existingRoleCount > 0) {
    blockers.push({ code: 'privileged_account', message: `${upn} already exists and holds a directory role. Refusing to modify it.` });
  }

  // Resolve the baseline by SKU part number; a missing SKU or an exhausted pool fails the
  // dry run closed rather than leaving a half-licensed account behind.
  const skuIds: string[] = [];
  for (const part of baselineSkus) {
    const sku = tenant.skus.find((s) => s.skuPartNumber === part);
    if (!sku) { blockers.push({ code: 'sku_missing', message: `License ${part} is not present in the tenant.` }); continue; }
    if (sku.enabled - sku.consumed <= 0) { blockers.push({ code: 'no_seats', message: `No seats remaining for ${part}.` }); continue; }
    skuIds.push(sku.skuId);
  }

  const groups = str(answers.security_groups).split(/[,\n]/).map((g) => g.trim()).filter(Boolean);

  const policyName = str(answers.cloud_pc_policy);
  let policyGroupId: string | null = null;
  if (policyName) {
    const policy = tenant.policies.find((p) => p.displayName === policyName);
    if (!policy) blockers.push({ code: 'policy_missing', message: `Cloud PC policy "${policyName}" was not found.` });
    else if (policy.groupIds.length === 0) blockers.push({ code: 'policy_unassigned', message: `Cloud PC policy "${policyName}" has no assignment group.` });
    else policyGroupId = policy.groupIds[0];
  }

  const steps: PlanStep[] = [
    { key: 'create_user', label: `Create ${upn}`, detail: { upn, displayName, adopting: Boolean(existingUser) } },
    { key: 'assign_licenses', label: `Assign ${skuIds.length} license(s)`, detail: { skuIds, skuPartNumbers: baselineSkus } },
  ];
  if (groups.length) steps.push({ key: 'add_groups', label: `Add to ${groups.length} group(s)`, detail: { groups } });
  if (policyGroupId) steps.push({ key: 'assign_cloudpc', label: `Add to Cloud PC group for "${policyName}"`, detail: { policyName, groupId: policyGroupId } });
  steps.push({ key: 'issue_tap', label: 'Issue Temporary Access Pass to supervisor', detail: { supervisor: str(answers.supervisor) } });
  if (policyGroupId) steps.push({ key: 'await_cloudpc', label: 'Wait for the Cloud PC to finish building', detail: { policyName } });

  return { upn, displayName, steps, blockers };
}
```

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- provisioning-planner`
Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/provisioning/planner.ts apps/api/test/provisioning-planner.test.ts
git commit -m "feat(provisioning): pure planner with UPN derivation, SKU resolution, and blockers"
```

---

## Task 12: Run and step tables

**Files:**
- Create: `apps/api/src/db/migrations/0054_provisioning_runs.sql`

**Interfaces:**
- Produces: tables `provisioning_runs`, `provisioning_steps`; permission `provisioning.execute`.

- [ ] **Step 1: Write the migration**

```sql
-- apps/api/src/db/migrations/0054_provisioning_runs.sql
-- Resumable provisioning runs. Retrying creates a NEW run; history is never overwritten,
-- so the tables double as the compliance record of what was done to the directory.
CREATE TABLE IF NOT EXISTS provisioning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','awaiting_cloudpc','succeeded','failed')),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid REFERENCES users(id),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provisioning_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES provisioning_runs(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  position int NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  request jsonb,
  response jsonb,
  graph_object_id text,
  error text,
  attempts int NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS provisioning_runs_awaiting_idx
  ON provisioning_runs (status) WHERE status = 'awaiting_cloudpc';

ALTER TABLE provisioning_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provisioning_runs_isolation ON provisioning_runs;
CREATE POLICY provisioning_runs_isolation ON provisioning_runs
  USING (organization_id = app_org_id() OR app_all_orgs());

INSERT INTO permissions (key, category, description) VALUES
  ('provisioning.execute', 'integration', 'Preview and execute Entra account provisioning')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'provisioning.execute' FROM roles r WHERE r.key IN ('SuperAdmin','ServiceDeskManager')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Apply and re-apply**

Run: `npm --workspace apps/api run migrate -- --env-file ../../.env` twice.
Expected: both runs succeed; the second is a no-op.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0054_provisioning_runs.sql
git commit -m "feat(db): provisioning runs and steps with provisioning.execute permission"
```

---

## Task 13: The executor

**Files:**
- Create: `apps/api/src/modules/provisioning/executor.ts`
- Test: `apps/api/test/provisioning-executor.test.ts`

**Interfaces:**
- Consumes: `Plan`, `PlanStep`, `StepKey` (Task 11); the Graph adapter (Task 10).
- Produces:
  - `StepOutcome { key: StepKey; status: 'succeeded' | 'failed' | 'skipped'; graphObjectId?: string; error?: string }`
  - `ProvisioningOps` — the injectable seam over Graph (one method per operation).
  - `executePlan(plan: Plan, ops: ProvisioningOps): Promise<{ outcomes: StepOutcome[]; status: 'succeeded' | 'failed' | 'awaiting_cloudpc' }>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/provisioning-executor.test.ts
import { describe, it, expect } from 'vitest';
import { executePlan, type ProvisioningOps } from '../src/modules/provisioning/executor.js';
import type { Plan } from '../src/modules/provisioning/planner.js';

const plan: Plan = {
  upn: 'ada.lovelace@sbsfederal.com', displayName: 'Ada Lovelace', blockers: [],
  steps: [
    { key: 'create_user', label: '', detail: { upn: 'ada.lovelace@sbsfederal.com', displayName: 'Ada Lovelace', adopting: false } },
    { key: 'assign_licenses', label: '', detail: { skuIds: ['e3'] } },
    { key: 'assign_cloudpc', label: '', detail: { groupId: 'g-cloudpc' } },
    { key: 'issue_tap', label: '', detail: {} },
    { key: 'await_cloudpc', label: '', detail: {} },
  ],
};

function ops(over: Partial<ProvisioningOps> = {}): ProvisioningOps {
  return {
    findUser: async () => null,
    createUser: async () => ({ id: 'u1' }),
    currentLicenses: async () => [],
    assignLicenses: async () => ({}),
    addToGroup: async () => ({}),
    issueTap: async () => ({ temporaryAccessPass: 'TAP123' }),
    deliverTap: async () => {},
    ...over,
  };
}

describe('executePlan', () => {
  it('runs the steps in order and rests at awaiting_cloudpc', async () => {
    const r = await executePlan(plan, ops());
    expect(r.status).toBe('awaiting_cloudpc');
    expect(r.outcomes.map((o) => o.key)).toEqual(['create_user', 'assign_licenses', 'assign_cloudpc', 'issue_tap', 'await_cloudpc']);
  });

  it('adopts an existing user instead of creating a duplicate', async () => {
    let created = 0;
    const r = await executePlan(plan, ops({
      findUser: async () => ({ id: 'existing', userPrincipalName: 'ada.lovelace@sbsfederal.com' }),
      createUser: async () => { created += 1; return { id: 'new' }; },
    }));
    expect(created).toBe(0);
    expect(r.outcomes[0].graphObjectId).toBe('existing');
  });

  it('assigns only the licences the user is missing', async () => {
    let requested: string[] = [];
    await executePlan(plan, ops({
      currentLicenses: async () => ['e3'],
      assignLicenses: async (_id, skuIds) => { requested = skuIds; return {}; },
    }));
    expect(requested).toEqual([]);
  });

  it('stops at the failing step and does not run later ones', async () => {
    const r = await executePlan(plan, ops({
      assignLicenses: async () => { throw new Error('seat exhausted'); },
    }));
    expect(r.status).toBe('failed');
    expect(r.outcomes.find((o) => o.key === 'assign_licenses')?.error).toContain('seat exhausted');
    expect(r.outcomes.map((o) => o.key)).not.toContain('assign_cloudpc');
  });

  it('refuses to execute a plan carrying blockers', async () => {
    const blocked = { ...plan, blockers: [{ code: 'no_seats', message: 'No seats remaining.' }] };
    await expect(executePlan(blocked, ops())).rejects.toThrow(/blocker/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- provisioning-executor`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/provisioning/executor.ts
// Walks a Plan with side effects enabled. Every step is idempotent so a retry after a partial
// run adopts what already exists instead of duplicating it. Graph access is injected via
// ProvisioningOps so the whole engine is testable with no network.
import type { Plan, StepKey } from './planner.js';

export interface StepOutcome {
  key: StepKey;
  status: 'succeeded' | 'failed' | 'skipped';
  graphObjectId?: string;
  error?: string;
}

export interface ProvisioningOps {
  findUser: (upn: string) => Promise<{ id: string; userPrincipalName: string } | null>;
  createUser: (body: Record<string, unknown>) => Promise<{ id: string }>;
  currentLicenses: (userId: string) => Promise<string[]>;
  assignLicenses: (userId: string, skuIds: string[]) => Promise<unknown>;
  addToGroup: (groupId: string, userId: string) => Promise<unknown>;
  issueTap: (userId: string) => Promise<{ temporaryAccessPass: string }>;
  deliverTap: (supervisorId: string, upn: string, pass: string) => Promise<void>;
}

export async function executePlan(
  plan: Plan,
  ops: ProvisioningOps,
): Promise<{ outcomes: StepOutcome[]; status: 'succeeded' | 'failed' | 'awaiting_cloudpc' }> {
  if (plan.blockers.length > 0) {
    throw new Error(`refusing to execute: plan has ${plan.blockers.length} blocker(s)`);
  }

  const outcomes: StepOutcome[] = [];
  let userId = '';
  let awaiting = false;

  for (const step of plan.steps) {
    try {
      switch (step.key) {
        case 'create_user': {
          const existing = await ops.findUser(plan.upn);
          if (existing) userId = existing.id;                       // adopt, never duplicate
          else userId = (await ops.createUser({
            accountEnabled: true,
            displayName: plan.displayName,
            userPrincipalName: plan.upn,
            mailNickname: plan.upn.split('@')[0],
            passwordProfile: { forceChangePasswordNextSignIn: true, password: cryptoPassword() },
          })).id;
          outcomes.push({ key: step.key, status: 'succeeded', graphObjectId: userId });
          break;
        }
        case 'assign_licenses': {
          const want = (step.detail.skuIds as string[]) ?? [];
          const have = await ops.currentLicenses(userId);
          const missing = want.filter((s) => !have.includes(s));   // assign only the delta
          if (missing.length) await ops.assignLicenses(userId, missing);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'add_groups': {
          for (const g of (step.detail.groupIds as string[]) ?? []) await ops.addToGroup(g, userId);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'assign_cloudpc': {
          await ops.addToGroup(step.detail.groupId as string, userId);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'issue_tap': {
          const tap = await ops.issueTap(userId);
          await ops.deliverTap(String(step.detail.supervisor ?? ''), plan.upn, tap.temporaryAccessPass);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'await_cloudpc': {
          awaiting = true;                                          // the poller takes it from here
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
      }
    } catch (err) {
      outcomes.push({ key: step.key, status: 'failed', error: (err as Error).message });
      return { outcomes, status: 'failed' };                        // stop at the first failure
    }
  }

  return { outcomes, status: awaiting ? 'awaiting_cloudpc' : 'succeeded' };
}

/** Throwaway initial password — the account signs in with a TAP, and this is force-reset. */
function cryptoPassword(): string {
  return `${crypto.randomUUID()}Aa1!`;
}
```

> **Seam:** `add_groups` reads `detail.groupIds`, but Task 11's planner emits group **names**
> in `detail.groups` — the planner is pure and cannot look them up. Task 15's `buildPlan`
> closes the gap by resolving names to IDs and writing `detail.groupIds` before `executePlan`
> is called. Do not "fix" this by making the planner do I/O; the purity is what makes the
> preview and the execution provably the same plan.

- [ ] **Step 4: Run tests**

Run: `npm --workspace apps/api run test -- provisioning-executor && npm run typecheck`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/provisioning/executor.ts apps/api/test/provisioning-executor.test.ts
git commit -m "feat(provisioning): idempotent step executor with adoption and delta licensing"
```

---

## Task 14: Cloud PC poller

**Files:**
- Create: `apps/api/src/jobs/cloudpc-poller.ts`
- Modify: `apps/api/src/server.ts` (register beside the other jobs)
- Test: `apps/api/test/cloudpc-poller.test.ts`

**Interfaces:**
- Consumes: `getCloudPcStatus` (Task 10), `provisioning_runs` (Task 12).
- Produces: `nextRunState(status, startedAt, now, deadlineMs)` — pure; `startCloudPcPoller(intervalMs?)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/cloudpc-poller.test.ts
import { describe, it, expect } from 'vitest';
import { nextRunState } from '../src/jobs/cloudpc-poller.js';

const start = new Date('2026-09-01T00:00:00Z');
const DEADLINE = 4 * 60 * 60 * 1000;

describe('nextRunState', () => {
  it('completes the run once the Cloud PC reports provisioned', () => {
    expect(nextRunState('provisioned', start, new Date('2026-09-01T00:40:00Z'), DEADLINE))
      .toEqual({ status: 'succeeded', error: null });
  });

  it('keeps waiting while the build is in progress', () => {
    expect(nextRunState('provisioning', start, new Date('2026-09-01T00:40:00Z'), DEADLINE))
      .toEqual({ status: 'awaiting_cloudpc', error: null });
  });

  it('keeps waiting when the Cloud PC has not appeared yet', () => {
    expect(nextRunState(null, start, new Date('2026-09-01T00:05:00Z'), DEADLINE).status)
      .toBe('awaiting_cloudpc');
  });

  it('fails the run once the deadline passes', () => {
    const r = nextRunState('provisioning', start, new Date('2026-09-01T05:00:00Z'), DEADLINE);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/deadline/i);
  });

  it('fails immediately on a terminal Graph failure state', () => {
    expect(nextRunState('failed', start, new Date('2026-09-01T00:40:00Z'), DEADLINE).status)
      .toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- cloudpc-poller`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/jobs/cloudpc-poller.ts
// Advances runs parked in `awaiting_cloudpc`. Cloud PC builds are asynchronous (typically
// 30-90 minutes), so waiting is a normal resting state, not an error — only a terminal Graph
// failure or the deadline marks the run failed.
import { withSystemContext } from '../db/pool.js';
import { logger } from '../logger.js';

const FIVE_MIN = 5 * 60 * 1000;
export const CLOUDPC_DEADLINE_MS = 4 * 60 * 60 * 1000;

export function nextRunState(
  cloudPcStatus: string | null,
  startedAt: Date,
  now: Date,
  deadlineMs: number,
): { status: 'succeeded' | 'failed' | 'awaiting_cloudpc'; error: string | null } {
  if (cloudPcStatus === 'provisioned') return { status: 'succeeded', error: null };
  if (cloudPcStatus === 'failed') return { status: 'failed', error: 'Cloud PC provisioning failed in Windows 365.' };
  if (now.getTime() - startedAt.getTime() > deadlineMs) {
    return { status: 'failed', error: 'Cloud PC did not finish provisioning before the deadline.' };
  }
  return { status: 'awaiting_cloudpc', error: null };
}

export function startCloudPcPoller(intervalMs = FIVE_MIN): NodeJS.Timeout {
  const tick = async () => {
    try {
      await withSystemContext(async (sql) => {
        const { rows } = await sql.query(
          `SELECT r.id, r.started_at, r.plan FROM provisioning_runs r WHERE r.status = 'awaiting_cloudpc'`,
        );
        for (const run of rows) {
          // getCloudPcStatus(graph, upn) — build the client from config.provisioning here.
          const status: string | null = await lookupCloudPcStatus(run.plan?.upn);
          const next = nextRunState(status, new Date(run.started_at), new Date(), CLOUDPC_DEADLINE_MS);
          if (next.status === 'awaiting_cloudpc') continue;
          await sql.query(
            `UPDATE provisioning_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1`,
            [run.id, next.status, next.error],
          );
        }
      });
    } catch (err) {
      logger.error({ err }, 'cloud pc poller tick failed');
    }
  };
  return setInterval(tick, intervalMs);
}
```

And the lookup in the same file — inert when the feature flag is off, and never allowed to
kill the tick:

```ts
async function lookupCloudPcStatus(upn: string | undefined): Promise<string | null> {
  if (!config.provisioning.enabled || !upn) return null;
  try {
    const graph = createGraphClient({
      graphEndpoint: graphEndpointFor(config.provisioning.cloud),
      getToken: () => provisioningToken(),
      fetchImpl: fetch as never,
      apiVersion: 'v1.0', // see Open Item 3 — may need 'beta' in GCC High
    });
    return await getCloudPcStatus(graph, upn);
  } catch (err) {
    // A transient Graph error must not advance the run; stay parked and retry next tick.
    logger.warn({ err, upn }, 'cloud pc status lookup failed');
    return null;
  }
}
```

Note the failure mode: returning `null` keeps the run in `awaiting_cloudpc`, so a Graph outage
delays completion rather than falsely failing a run. The deadline still bounds it.

- [ ] **Step 4: Register in `server.ts`**

Beside the existing job starts, guarded by the flag:

```ts
if (config.provisioning.enabled) startCloudPcPoller();
```

- [ ] **Step 5: Run tests**

Run: `npm --workspace apps/api run test -- cloudpc-poller && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/cloudpc-poller.ts apps/api/src/server.ts apps/api/test/cloudpc-poller.test.ts
git commit -m "feat(provisioning): Cloud PC poller with deadline handling"
```

---

## Task 15: Provisioning service and HTTP routes

**Files:**
- Create: `apps/api/src/modules/provisioning/index.ts`
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/provisioning-service.test.ts`

**Interfaces:**
- Consumes: planner (11), executor (13), Graph adapter (10), config (9), `readSensitiveForEngine` (3).
- Produces:
  - `preview(actor, ticketId): Promise<Plan>`
  - `provision(actor, ticketId): Promise<{ runId: string; status: string; outcomes: StepOutcome[] }>`
  - `listRuns(actor, ticketId)`
  - `listCloudPcPolicies(actor): Promise<string[]>`
  - Routes: `GET /api/v1/tickets/:id/provisioning` (runs), `POST /api/v1/tickets/:id/provisioning/preview`, `POST /api/v1/tickets/:id/provisioning/execute`, `GET /api/v1/provisioning/cloud-pc-policies`.

- [ ] **Step 1: Write the failing test (pure group resolution)**

```ts
// apps/api/test/provisioning-service.test.ts
import { describe, it, expect } from 'vitest';
import { resolveGroupIds } from '../src/modules/provisioning/index.js';

describe('resolveGroupIds', () => {
  const directory = [{ id: 'g1', displayName: 'All Staff' }, { id: 'g2', displayName: 'Engineering' }];

  it('maps group names to ids', () => {
    expect(resolveGroupIds(['All Staff', 'Engineering'], directory))
      .toEqual({ groupIds: ['g1', 'g2'], missing: [] });
  });

  it('reports names that do not resolve rather than silently dropping them', () => {
    expect(resolveGroupIds(['All Staff', 'Ghost'], directory))
      .toEqual({ groupIds: ['g1'], missing: ['Ghost'] });
  });

  it('is case-insensitive', () => {
    expect(resolveGroupIds(['all staff'], directory).groupIds).toEqual(['g1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/api run test -- provisioning-service`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service**

```ts
// apps/api/src/modules/provisioning/index.ts
// Ties the planner, the executor, and Graph together. `preview` and `provision` build the plan
// through the SAME planner call, so the preview an admin approves is the plan that runs.
import { withSystemContext } from '../../db/pool.js';
import { authorize } from '../../authz/pdp.js';
import { audit } from '../audit.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import { planRun, type Plan } from './planner.js';
import { executePlan, type ProvisioningOps } from './executor.js';
import type { Principal } from '../../types.js';

export function resolveGroupIds(
  names: string[],
  directory: Array<{ id: string; displayName: string }>,
): { groupIds: string[]; missing: string[] } {
  const byName = new Map(directory.map((g) => [g.displayName.toLowerCase(), g.id]));
  const groupIds: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const id = byName.get(n.trim().toLowerCase());
    if (id) groupIds.push(id); else missing.push(n);
  }
  return { groupIds, missing };
}
```

Then the plan builder. Note it **rewrites the `add_groups` step's `detail`**, replacing the
planner's group *names* with resolved group *IDs* — this is the seam between Task 11 (which
cannot do I/O) and Task 13 (which expects `detail.groupIds`).

```ts
async function buildPlan(actor: Principal, ticketId: string): Promise<Plan> {
  if (!config.provisioning.enabled) throw Errors.badRequest('provisioning is not enabled');

  const ticket = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT id, organization_id, custom_fields FROM tickets WHERE id = $1', [ticketId]);
    return rows[0];
  });
  if (!ticket) throw Errors.notFound('ticket not found');
  authorize(actor, 'provisioning.execute', { organizationId: ticket.organization_id });

  // PII lives outside custom_fields; the engine reads it in system context.
  const answers = { ...(ticket.custom_fields ?? {}), ...(await readSensitiveForEngine(ticketId)) };

  const { graph, policyGraph } = graphClients();
  const tenant = await readTenantState(graph, policyGraph);
  const upn = deriveUpn(answers, config.provisioning.upnDomain);
  const existingUser = await findUserByUpn(graph, upn);
  const existingRoleCount = existingUser ? await directoryRoleCount(graph, existingUser.id) : 0;

  const plan = planRun({
    answers, tenant,
    upnDomain: config.provisioning.upnDomain,
    baselineSkus: config.provisioning.baselineSkus,
    existingUser, existingRoleCount,
  });

  // Resolve group names -> ids. Unresolved names become blockers rather than silent no-ops.
  const groupStep = plan.steps.find((s) => s.key === 'add_groups');
  if (groupStep) {
    const directory = await listGroups(graph);
    const { groupIds, missing } = resolveGroupIds(groupStep.detail.groups as string[], directory);
    groupStep.detail.groupIds = groupIds;
    for (const name of missing) {
      plan.blockers.push({ code: 'group_missing', message: `Group "${name}" was not found in the directory.` });
    }
  }
  return plan;
}

export async function preview(actor: Principal, ticketId: string): Promise<Plan> {
  return buildPlan(actor, ticketId);
}

export async function provision(actor: Principal, ticketId: string) {
  const plan = await buildPlan(actor, ticketId);
  if (plan.blockers.length) throw Errors.badRequest(`plan has ${plan.blockers.length} blocker(s)`);

  const runId = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO provisioning_runs (ticket_id, organization_id, status, plan, started_by, started_at)
       SELECT $1, t.organization_id, 'running', $2::jsonb, $3, now() FROM tickets t WHERE t.id = $1
       RETURNING id`,
      [ticketId, JSON.stringify(plan), actor.id]);
    const id = rows[0].id;
    for (const [i, step] of plan.steps.entries()) {
      await sql.query(
        `INSERT INTO provisioning_steps (run_id, step_key, position) VALUES ($1,$2,$3)`,
        [id, step.key, i]);
    }
    return id;
  });

  const { outcomes, status } = await executePlan(plan, buildOps());

  await withSystemContext(async (sql) => {
    for (const o of outcomes) {
      await sql.query(
        `UPDATE provisioning_steps SET status=$3, graph_object_id=$4, error=$5,
                attempts = attempts + 1, finished_at = now()
         WHERE run_id=$1 AND step_key=$2`,
        [runId, o.key, o.status, o.graphObjectId ?? null, o.error ?? null]);
    }
    await sql.query(
      `UPDATE provisioning_runs SET status=$2, error=$3,
              finished_at = CASE WHEN $2 = 'awaiting_cloudpc' THEN NULL ELSE now() END
       WHERE id=$1`,
      [runId, status, outcomes.find((o) => o.error)?.error ?? null]);
  });

  await addWorklog(ticketId, `Provisioning run ${status}: ` +
    outcomes.map((o) => `${o.key}=${o.status}`).join(', '));

  await audit(actor, {
    action: 'provisioning.executed',
    organizationId: null,
    resourceType: 'ticket',
    resourceId: ticketId,
    detail: { runId, status, upn: plan.upn, steps: outcomes.map((o) => ({ key: o.key, status: o.status })) },
  });

  return { runId, status, outcomes };
}
```

`graphClients()` builds the Graph client pair from `config.provisioning` via
`createTokenProvider` (policy client with `apiVersion` per Open Item 3). `buildOps()` returns a
`ProvisioningOps` whose methods delegate to the Task 10 adapter, with `deliverTap` sending the
pass to the supervisor's work mailbox through the existing notification path — never to the
personal address captured on the form. `listGroups(graph)` is
`g.get('/groups?$select=id,displayName')` normalized to `{ id, displayName }[]`.

- [ ] **Step 4: Add the routes**

```ts
app.post('/api/v1/tickets/:id/provisioning/preview', async (req) => {
  const p = principal(req);
  const { id } = req.params as { id: string };
  return { data: await provisioning.preview(p, id) };
});

app.post('/api/v1/tickets/:id/provisioning/execute', async (req) => {
  const p = principal(req);
  const { id } = req.params as { id: string };
  return { data: await provisioning.provision(p, id) };
});

app.get('/api/v1/tickets/:id/provisioning', async (req) => {
  const p = principal(req);
  const { id } = req.params as { id: string };
  return { data: await provisioning.listRuns(p, id) };
});

app.get('/api/v1/provisioning/cloud-pc-policies', async (req) => {
  return { data: await provisioning.listCloudPcPolicies(principal(req)) };
});
```

- [ ] **Step 5: Run the full suite**

Run: `npm --workspace apps/api run test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/provisioning/index.ts apps/api/src/http/routes.ts apps/api/test/provisioning-service.test.ts
git commit -m "feat(provisioning): preview/execute service and HTTP routes"
```

---

## Task 16: Provisioning panel

**Files:**
- Create: `apps/web/components/provisioning-panel.tsx`
- Modify: `apps/web/app/(app)/tickets/[id]/page.tsx`

**Interfaces:**
- Consumes: the four routes from Task 15.
- Produces: `<ProvisioningPanel ticketId={…} canProvision={…} />`.

- [ ] **Step 1: Build the panel**

```tsx
// apps/web/components/provisioning-panel.tsx
'use client';
import { useState } from 'react';

interface Blocker { code: string; message: string }
interface PlanStep { key: string; label: string }
interface Plan { upn: string; displayName: string; steps: PlanStep[]; blockers: Blocker[] }

export function ProvisioningPanel({ ticketId, canProvision }: { ticketId: string; canProvision: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; outcomes: Array<{ key: string; status: string; error?: string }> } | null>(null);

  if (!canProvision) return null;
  const blocked = (plan?.blockers.length ?? 0) > 0;

  async function call(path: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/tickets/${ticketId}/provisioning/${path}`, { method: 'POST' });
      return (await res.json()).data;
    } finally { setBusy(false); }
  }

  return (
    <section className="rounded border p-4 space-y-3">
      <h2 className="font-semibold">Provisioning</h2>

      <button className="rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-50"
              disabled={busy} onClick={async () => setPlan(await call('preview'))}>
        {busy ? 'Working…' : 'Preview'}
      </button>

      {plan ? (
        <div className="space-y-2">
          <p className="text-sm">Will create <code>{plan.upn}</code> ({plan.displayName})</p>
          <ol className="list-decimal pl-5 text-sm">
            {plan.steps.map((s) => <li key={s.key}>{s.label}</li>)}
          </ol>
          {blocked ? (
            <ul className="rounded bg-red-50 p-2 text-sm text-red-800">
              {plan.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
            </ul>
          ) : null}
          <button className="rounded bg-emerald-700 px-3 py-1 text-white disabled:opacity-50"
                  disabled={busy || blocked}
                  onClick={async () => setResult(await call('execute'))}>
            Provision
          </button>
        </div>
      ) : null}

      {result ? (
        <ul className="text-sm">
          {result.outcomes.map((o) => (
            <li key={o.key}>{o.key}: {o.status}{o.error ? ` — ${o.error}` : ''}</li>
          ))}
          <li className="mt-1 font-medium">Run status: {result.status}</li>
        </ul>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 2: Mount it on the ticket page**

Render `<ProvisioningPanel ticketId={id} canProvision={perms.includes('provisioning.execute')} />`
only when the ticket's approval is granted, following how the page already gates other panels.

- [ ] **Step 3: Verify the build**

Run: `npm --workspace apps/web run typecheck && (cd apps/web && NEXT_DIST_DIR=.next-verify npx next build)`
Expected: typecheck clean, build succeeds. Then `rm -rf apps/web/.next-verify`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/provisioning-panel.tsx "apps/web/app/(app)/tickets/[id]/page.tsx"
git commit -m "feat(web): provisioning panel with dry-run preview and blocker gating"
```

---

## Before deploying Phase 2

Confirm the four Open Items from the spec against the SBS tenant:

0. **Create the `Anchor-Provisioning` app registration** in the SBS Federal tenant — separate
   from `Anchor-Authentication`, which must keep only its mail scopes. Grant and admin-consent
   `User.ReadWrite.All`, `Organization.Read.All`, `Group.ReadWrite.All`,
   `UserAuthenticationMethod.ReadWrite.All`, `CloudPC.ReadWrite.All`. Record the client secret's
   expiry somewhere that will alert you before it lapses.
1. `az` into the tenant and enumerate `/subscribedSkus`; record exact `skuPartNumber` values in `M365_PROV_BASELINE_SKUS`. **Verify a Windows 365 Enterprise SKU is among them** — without it `assign_cloudpc` appears to succeed and the Cloud PC never builds.
2. Decide administrative-unit scoping for `Anchor-Provisioning`, or accept tenant-wide scope with the UPN allow-list and privileged-account refusal as compensating controls.
3. Probe whether `/deviceManagement/virtualEndpoint/*` is on `v1.0` or `beta` in GCC High; set `apiVersion` accordingly in the policy client.
4. Confirm the Temporary Access Pass policy is enabled. If not, mark `issue_tap` skipped and set first credentials out-of-band.

Then set the `M365_PROV_*` App Service settings and flip `M365_PROV_ENABLED=true`.

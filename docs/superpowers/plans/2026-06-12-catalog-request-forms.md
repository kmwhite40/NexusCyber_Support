# Catalog Request Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render JSM-style custom request forms in the service catalog (people pickers, system select, attachment), starting with "New user creation & provisioning", and on submit create the right ticket — requester from on-behalf-of, approvers as approval steps, file attached.

**Architecture:** Reuse the existing `request_forms`/`form_fields` tables. A migration links catalog items to forms, adds `user`/`user_multi`/`attachment` field types and a `maps_to` routing column, and seeds the form. The backend gains read endpoints (form-by-catalog-key, user search), and `catalog.createRequest` is extended to route mapped answers via a new pure `mapFormAnswers`. The web `RequestModal` renders the form dynamically with a reusable `UserPicker`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify, `pg`, vitest (API); Next.js + React + Tailwind (web). Reference spec: [docs/superpowers/specs/2026-06-12-catalog-request-forms-design.md](../specs/2026-06-12-catalog-request-forms-design.md)

---

## Conventions

- API work runs from `apps/api/`; tests `npm test`, typecheck `npm run typecheck`.
- ESM `.js` import specifiers. Commit after each task. Stage only the task's files (the branch has concurrent activity).
- Migration number: use the **next free** number (0031 is taken twice; this plan uses **0032** — verify `ls apps/api/src/db/migrations/` and bump if needed).
- DB for live apply runs on host port 5544; pass `DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus` explicitly (no dotenv autoload).

---

# TIER 1 — Schema + read endpoints

## Task 1: Migration — link forms, new field types, routing, seed

**Files:**
- Create: `apps/api/src/db/migrations/0032_catalog_request_forms.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Catalog request forms: link items to forms, add people-picker/attachment field types,
-- semantic answer routing (maps_to), and seed the "New user creation & provisioning" form.
ALTER TABLE service_catalog_items ADD COLUMN IF NOT EXISTS form_key text;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS maps_to text;

-- Inline CHECK constraints are auto-named <table>_<column>_check.
ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN ('text','textarea','number','select','checkbox','date','user','user_multi','attachment'));

DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key = 'new_user_provisioning' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'new_user_provisioning', 'New user creation & provisioning', 'access_request')
    RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'Raise this request on behalf of', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'system', 'Select a system', 'select', true,
       '["M365 / Entra ID","Azure Government","AWS GovCloud","Jira","ServiceNow","VPN"]', 2, NULL),
    (f, 'reason', 'Tell us why you need an account', 'textarea', false, '[]', 3, 'description'),
    (f, 'manager', 'Manager', 'user', false, '[]', 4, 'manager'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 5, 'approvers'),
    (f, 'attachment', 'Attachment', 'attachment', false, '[]', 6, 'attachment')
  ON CONFLICT (form_id, key) DO UPDATE SET
    label = EXCLUDED.label, data_type = EXCLUDED.data_type, required = EXCLUDED.required,
    options = EXCLUDED.options, position = EXCLUDED.position, maps_to = EXCLUDED.maps_to;
END $$;

UPDATE service_catalog_items SET form_key = 'new_user_provisioning' WHERE key = 'user.provisioning';
```

- [ ] **Step 2: Apply + verify**

Run (from `apps/api`):
```bash
DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus node -e "import('pg').then(async({default:pg})=>{const c=new pg.Client(process.env.DATABASE_URL);await c.connect();const ddl=require('fs').readFileSync('src/db/migrations/0032_catalog_request_forms.sql','utf8');await c.query(ddl);const r=await c.query(\"select key,label,data_type,maps_to from form_fields ff join request_forms f on f.id=ff.form_id where f.key='new_user_provisioning' order by position\");console.table(r.rows);const link=await c.query(\"select key,form_key from service_catalog_items where key='user.provisioning'\");console.log(link.rows[0]);await c.end()})"
```
Expected: 7 fields listed (on_behalf_of … attachment), and `user.provisioning → form_key new_user_provisioning`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0032_catalog_request_forms.sql
git commit -m "feat(forms): migration — catalog form link, people/attachment field types, seed new-user form"
```

---

## Task 2: Extend form field types + validation

**Files:**
- Modify: `apps/api/src/modules/forms.ts`
- Test: `apps/api/test/forms.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/forms.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateAgainstForm, type FormField } from '../src/modules/forms.js';

const F = (over: Partial<FormField>): FormField => ({
  key: 'k', label: 'K', data_type: 'text', required: false, options: [], maps_to: null, ...over,
});

describe('validateAgainstForm — people + attachment types', () => {
  it('accepts a user id string for a required user field', () => {
    const r = validateAgainstForm([F({ key: 'u', label: 'User', data_type: 'user', required: true })], { u: 'usr-1' });
    expect(r.ok).toBe(true);
  });

  it('flags a missing required user field', () => {
    const r = validateAgainstForm([F({ key: 'u', label: 'User', data_type: 'user', required: true })], {});
    expect(r.ok).toBe(false);
    expect(r.errors[0].field).toBe('u');
  });

  it('treats an empty array as missing for a required user_multi field', () => {
    const r = validateAgainstForm([F({ key: 'a', label: 'Approvers', data_type: 'user_multi', required: true })], { a: [] });
    expect(r.ok).toBe(false);
  });

  it('accepts an array of ids for user_multi', () => {
    const r = validateAgainstForm([F({ key: 'a', label: 'Approvers', data_type: 'user_multi', required: true })], { a: ['x', 'y'] });
    expect(r.ok).toBe(true);
  });

  it('does not validate attachment fields (handled out of band)', () => {
    const r = validateAgainstForm([F({ key: 'f', label: 'File', data_type: 'attachment', required: true })], {});
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- forms`
Expected: FAIL — `FormField` has no `maps_to`, and `user`/`user_multi`/`attachment` not handled.

- [ ] **Step 3: Edit `apps/api/src/modules/forms.ts`**

Change the `FieldType` union and `FormField` interface:

```ts
export type FieldType =
  | 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date'
  | 'user' | 'user_multi' | 'attachment';

export interface FormField {
  key: string;
  label: string;
  data_type: FieldType;
  required: boolean;
  options: string[];
  maps_to: string | null;
}
```

Update the "missing" check and add type cases in `validateAgainstForm`. Replace the missing-check line and the `switch` with:

```ts
    const missing =
      v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (missing) {
      if (f.required) errors.push({ field: f.key, message: `${f.label} is required` });
      continue;
    }
    switch (f.data_type) {
      case 'number':
        if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))) {
          errors.push({ field: f.key, message: `${f.label} must be a number` });
        }
        break;
      case 'select':
        if (!f.options.includes(String(v))) errors.push({ field: f.key, message: `${f.label} must be one of: ${f.options.join(', ')}` });
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') errors.push({ field: f.key, message: `${f.label} must be true or false` });
        break;
      case 'date':
        if (typeof v !== 'string' || !ISO_DATE.test(v)) errors.push({ field: f.key, message: `${f.label} must be a date (YYYY-MM-DD)` });
        break;
      case 'user':
        if (typeof v !== 'string') errors.push({ field: f.key, message: `${f.label} must be a user` });
        break;
      case 'user_multi':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push({ field: f.key, message: `${f.label} must be a list of users` });
        break;
      // 'attachment': handled out of band (file upload); no validation here.
      // 'text' / 'textarea': no extra validation.
    }
```

Update `loadFields` to select and return `maps_to`:

```ts
async function loadFields(sql: import('../db/pool.js').Sql, formId: string): Promise<FormField[]> {
  const { rows } = await sql.query(
    'SELECT key, label, data_type, required, options, maps_to FROM form_fields WHERE form_id=$1 ORDER BY position',
    [formId],
  );
  return rows.map((r) => ({
    key: r.key, label: r.label, data_type: r.data_type, required: r.required,
    options: (r.options as string[]) ?? [], maps_to: r.maps_to ?? null,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- forms && npm run typecheck`
Expected: PASS (5 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/forms.ts apps/api/test/forms.test.ts
git commit -m "feat(forms): user/user_multi/attachment field types + maps_to"
```

---

## Task 3: Form-by-catalog-key endpoint

**Files:**
- Modify: `apps/api/src/modules/forms.ts`
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Add `getFormByCatalogKey` to `apps/api/src/modules/forms.ts`**

Add after `getForm`:

```ts
/** Resolve the form linked to a catalog item (service_catalog_items.form_key). Null when none. */
export async function getFormByCatalogKey(actor: Principal, catalogKey: string) {
  authorize(actor, 'ticket.create');
  return withSystemContext(async (sql) => {
    const item = (
      await sql.query('SELECT form_key FROM service_catalog_items WHERE key=$1 AND active', [catalogKey])
    ).rows[0];
    if (!item?.form_key) return null;
    const form = (
      await sql.query('SELECT * FROM request_forms WHERE key=$1 AND organization_id IS NULL AND active', [item.form_key])
    ).rows[0];
    if (!form) return null;
    const fields = await loadFields(sql, form.id);
    return { ...form, fields };
  });
}
```

(Global forms live with `organization_id IS NULL`; reading via `withSystemContext` avoids RLS on this global config — consistent with how `catalog.createRequest` reads catalog items.)

- [ ] **Step 2: Add the route in `apps/api/src/http/routes.ts`**

First wire the import: at the top with the other `import * as <module>` lines, add (if not already present):

```ts
import * as forms from '../modules/forms.js';
```

Then find the catalog request route (`app.post('/api/v1/catalog/:key/request'...`) and add **above** it:

```ts
  app.get('/api/v1/catalog/:key/form', async (req) => {
    const p = await requirePrincipal(req);
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const form = await forms.getFormByCatalogKey(p, key);
    return { form };
  });
```

- [ ] **Step 3: Verify build + smoke**

Run: `npm run typecheck`
Expected: clean.

Smoke (API running, with a dev session cookie/token):
```bash
curl -s -b /tmp/su.txt http://localhost:4000/api/v1/catalog/user.provisioning/form | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);console.log('fields:', (j.form?.fields||[]).map(f=>f.key+':'+f.data_type).join(', '))})"
```
Expected: `on_behalf_of:user, summary:text, system:select, reason:textarea, manager:user, approvers:user_multi, attachment:attachment`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/forms.ts apps/api/src/http/routes.ts
git commit -m "feat(forms): GET /catalog/:key/form endpoint"
```

---

## Task 4: User search endpoint

**Files:**
- Modify: `apps/api/src/modules/accounts.ts`
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/user-search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/user-search.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveSearchOrg } from '../src/modules/accounts.js';
import type { Principal } from '../src/types.js';

const customer = (over: Partial<Principal> = {}): Principal => ({
  id: 'u1', plane: 'customer', email: 'u@acme', displayName: null, organizationId: 'org-acme',
  roles: ['EndUser'], permissions: ['ticket.create'], assignedOrgs: [], elevated: false, ...over,
});
const agent = (over: Partial<Principal> = {}): Principal => ({
  id: 'a1', plane: 'nexus', email: 'a@nexus', displayName: null, organizationId: null,
  roles: ['Tier2'], permissions: ['ticket.create'], assignedOrgs: ['org-acme'], elevated: false, ...over,
});

describe('resolveSearchOrg', () => {
  it('forces a customer to their own org regardless of requested org', () => {
    expect(resolveSearchOrg(customer(), 'org-other')).toBe('org-acme');
  });
  it('uses the requested org for a nexus agent', () => {
    expect(resolveSearchOrg(agent(), 'org-acme')).toBe('org-acme');
  });
  it('returns null for a nexus agent with no org specified', () => {
    expect(resolveSearchOrg(agent(), undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- user-search`
Expected: FAIL — `resolveSearchOrg` not exported.

- [ ] **Step 3: Add to `apps/api/src/modules/accounts.ts`**

Add (near the top-level exports; ensure `withOrgContext`, `orgContextFor`, `authorize` are imported in this file — they are used elsewhere in accounts.ts):

```ts
/** Which org a people-picker search runs in: customers are pinned to their own org. Pure. */
export function resolveSearchOrg(actor: Principal, organizationId?: string): string | null {
  if (actor.plane === 'customer') return actor.organizationId ?? null;
  return organizationId ?? null;
}

export interface UserHit {
  id: string;
  display_name: string | null;
  email: string;
}

/** Type-ahead user search for people pickers, scoped to one org and RLS-enforced. */
export async function searchUsers(actor: Principal, q: string, organizationId?: string): Promise<UserHit[]> {
  const orgId = resolveSearchOrg(actor, organizationId);
  if (!orgId) return [];
  authorize(actor, 'ticket.create', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const term = (q ?? '').trim();
    const { rows } = await sql.query(
      `SELECT id, display_name, email FROM users
        WHERE organization_id = $1 AND status = 'active'
          AND ($2 = '' OR display_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
        ORDER BY display_name NULLS LAST LIMIT 10`,
      [orgId, term],
    );
    return rows as UserHit[];
  });
}
```

If `accounts.ts` does not already import these, add to its imports:

```ts
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
```

(Check the existing imports first — only add what's missing.)

- [ ] **Step 4: Add the route in `apps/api/src/http/routes.ts`**

Add near the organizations/users routes:

```ts
  app.get('/api/v1/users/search', async (req) => {
    const p = await requirePrincipal(req);
    const q = z.object({ q: z.string().optional(), organizationId: z.string().uuid().optional() }).parse(req.query);
    const data = await accounts.searchUsers(p, q.q ?? '', q.organizationId);
    return { data };
  });
```

(`accounts` is already imported in routes.ts.)

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- user-search && npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/accounts.ts apps/api/src/http/routes.ts apps/api/test/user-search.test.ts
git commit -m "feat(forms): GET /users/search for people pickers (org-scoped)"
```

---

# TIER 2 — Submit routing

## Task 5: `mapFormAnswers` (pure routing)

**Files:**
- Modify: `apps/api/src/modules/forms.ts`
- Test: `apps/api/test/form-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/form-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapFormAnswers, type FormField } from '../src/modules/forms.js';

const F = (over: Partial<FormField>): FormField => ({
  key: 'k', label: 'K', data_type: 'text', required: false, options: [], maps_to: null, ...over,
});

const FIELDS: FormField[] = [
  F({ key: 'on_behalf_of', data_type: 'user', maps_to: 'requester' }),
  F({ key: 'summary', data_type: 'text', maps_to: 'subject' }),
  F({ key: 'system', data_type: 'select', maps_to: null }),
  F({ key: 'reason', data_type: 'textarea', maps_to: 'description' }),
  F({ key: 'manager', data_type: 'user', maps_to: 'manager' }),
  F({ key: 'approvers', data_type: 'user_multi', maps_to: 'approvers' }),
  F({ key: 'attachment', data_type: 'attachment', maps_to: 'attachment' }),
];

describe('mapFormAnswers', () => {
  it('routes mapped fields to ticket columns / approvals / custom_fields', () => {
    const m = mapFormAnswers(FIELDS, {
      on_behalf_of: 'usr-cust', summary: 'Need Jira', system: 'Jira',
      reason: 'new hire', manager: 'usr-mgr', approvers: ['usr-a', 'usr-b'], attachment: 'ignored',
    });
    expect(m.subject).toBe('Need Jira');
    expect(m.description).toBe('new hire');
    expect(m.requesterId).toBe('usr-cust');
    expect(m.affectedUserId).toBe('usr-cust');
    expect(m.approverIds).toEqual(['usr-a', 'usr-b']);
    expect(m.customFields).toMatchObject({ system: 'Jira', manager: 'usr-mgr' });
    expect(m.customFields).not.toHaveProperty('attachment');
  });

  it('falls back to defaultRequesterId when on-behalf-of is empty', () => {
    const m = mapFormAnswers(FIELDS, { summary: 'x' }, { defaultRequesterId: 'self-1' });
    expect(m.requesterId).toBe('self-1');
    expect(m.affectedUserId).toBe('self-1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- form-mapping`
Expected: FAIL — `mapFormAnswers` not exported.

- [ ] **Step 3: Add `mapFormAnswers` to `apps/api/src/modules/forms.ts`**

```ts
export interface MappedAnswers {
  subject?: string;
  description?: string;
  requesterId?: string;
  affectedUserId?: string;
  customFields: Record<string, unknown>;
  approverIds: string[];
}

/** Route a form's answers to ticket columns, approval steps, and custom_fields. Pure. */
export function mapFormAnswers(
  fields: FormField[],
  answers: Record<string, unknown>,
  opts: { defaultRequesterId?: string | null } = {},
): MappedAnswers {
  const out: MappedAnswers = { customFields: {}, approverIds: [] };
  for (const f of fields) {
    const v = answers[f.key];
    switch (f.maps_to) {
      case 'subject':
        if (v) out.subject = String(v);
        break;
      case 'description':
        if (v) out.description = String(v);
        break;
      case 'requester':
        if (v) { out.requesterId = String(v); out.affectedUserId = String(v); }
        break;
      case 'approvers':
        if (Array.isArray(v)) out.approverIds = v.map(String).filter(Boolean);
        break;
      case 'attachment':
        break; // file handled out of band
      case 'manager':
        if (v) out.customFields[f.key] = v; // recorded; also available as custom field
        break;
      default:
        if (v !== undefined && v !== null && v !== '') out.customFields[f.key] = v;
    }
  }
  if (!out.requesterId && opts.defaultRequesterId) {
    out.requesterId = opts.defaultRequesterId;
    out.affectedUserId = opts.defaultRequesterId;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- form-mapping && npm run typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/forms.ts apps/api/test/form-mapping.test.ts
git commit -m "feat(forms): mapFormAnswers — route answers to ticket/approvals/custom_fields"
```

---

## Task 6: Wire form answers into `createRequest`

**Files:**
- Modify: `apps/api/src/modules/catalog.ts`
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Extend `CreateRequestInput` + imports in `apps/api/src/modules/catalog.ts`**

Add `answers` to the interface:

```ts
export interface CreateRequestInput {
  subject?: string;
  description?: string;
  organizationId?: string; // required for agent-created
  answers?: Record<string, unknown>;
}
```

Add the forms import at the top (with the other imports):

```ts
import { getFormByCatalogKey, validateAgainstForm, mapFormAnswers } from './forms.js';
```

- [ ] **Step 2: Resolve mapped answers before the ticket insert**

In `createRequest`, after the `{ item, grpId }` system-context block and before the `withOrgContext(...)` block, add:

```ts
  // If the catalog item has a custom form, validate + route its answers.
  let mapped: import('./forms.js').MappedAnswers | null = null;
  if (item.form_key && input.answers) {
    const form = await getFormByCatalogKey(actor, key);
    if (form) {
      const v = validateAgainstForm(form.fields, input.answers);
      if (!v.ok) throw Errors.validation(v.errors.map((e) => e.message).join('; '));
      mapped = mapFormAnswers(form.fields, input.answers, {
        defaultRequesterId: actor.plane === 'customer' ? actor.id : null,
      });
      if (actor.plane === 'nexus' && !mapped.requesterId) {
        throw Errors.badRequest('on-behalf-of is required for agent-created requests');
      }
    }
  }
```

- [ ] **Step 3: Use mapped values in the ticket insert**

The current INSERT sets `requester_id` to `actor.plane === 'customer' ? actor.id : null` and does not set `affected_user_id` or `custom_fields`. Replace the INSERT with one that honors `mapped`:

```ts
    const requesterId = mapped?.requesterId ?? (actor.plane === 'customer' ? actor.id : null);
    const affectedUserId = mapped?.affectedUserId ?? null;
    const customFields = mapped ? { ...mapped.customFields, _form: item.form_key } : {};
    const ticket = (
      await sql.query(
        `INSERT INTO tickets
           (organization_id, ticket_number, type, requester_id, affected_user_id, source_channel,
            subject, description, category, priority, status, assignment_group_id, custom_fields, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          orgId,
          `${prefix}-${String(n).padStart(6, '0')}`,
          item.ticket_type,
          requesterId,
          affectedUserId,
          actor.plane === 'customer' ? 'portal' : 'agent',
          mapped?.subject ?? input.subject ?? item.name,
          mapped?.description ?? input.description ?? null,
          item.key,
          item.default_priority,
          status,
          grpId,
          JSON.stringify(customFields),
          ['service_request', item.security_class],
        ],
      )
    ).rows[0];
```

- [ ] **Step 4: Insert approval steps for chosen approvers**

Find the existing `if (item.requires_approval)` block. It inserts an `approvals` row. Capture its id and add steps:

```ts
    if (item.requires_approval) {
      const approval = (
        await sql.query(
          `INSERT INTO approvals (organization_id, subject_type, subject_id, status)
           VALUES ($1,'ticket',$2,'requested') RETURNING id`,
          [orgId, ticket.id],
        )
      ).rows[0];
      const approverIds = mapped?.approverIds ?? [];
      for (let i = 0; i < approverIds.length; i++) {
        await sql.query(
          `INSERT INTO approval_steps (organization_id, approval_id, step_order, approver_id)
           VALUES ($1,$2,$3,$4)`,
          [orgId, approval.id, i, approverIds[i]],
        );
      }
      publish('approval.requested', orgId, { subject_type: 'ticket', subject_id: ticket.id });
    }
```

(If the current code inserts `approvals` without `RETURNING id`, this replaces it.)

- [ ] **Step 5: Extend the route body in `apps/api/src/http/routes.ts`**

Update the catalog request route's body schema:

```ts
    const body = z.object({
      subject: z.string().optional(),
      description: z.string().optional(),
      organizationId: z.string().uuid().optional(),
      answers: z.record(z.any()).optional(),
    }).parse(req.body);
```

- [ ] **Step 6: Typecheck + live smoke**

Run: `npm run typecheck && npm test -- form-mapping forms`
Expected: clean; tests pass.

Live smoke (API running, dev session as a customer of an org with users): post a form request and confirm the ticket has the routed subject/requester:
```bash
# replace IDs with real user ids from /users/search
curl -s -b /tmp/cust.txt -X POST http://localhost:4000/api/v1/catalog/user.provisioning/request \
  -H 'Content-Type: application/json' \
  -d '{"answers":{"on_behalf_of":"<USER_ID>","summary":"Account on Jira","system":"Jira","reason":"new hire","approvers":["<USER_ID>"]}}' | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const t=JSON.parse(s);console.log('subject:',t.subject,'| requester:',t.requester_id,'| custom:',JSON.stringify(t.custom_fields))})"
```
Expected: subject `Account on Jira`, requester = the on-behalf-of id, `custom_fields` includes `system: Jira`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/catalog.ts apps/api/src/http/routes.ts
git commit -m "feat(forms): route form answers in createRequest (requester, custom_fields, approval steps)"
```

---

# TIER 3 — Web

## Task 7: Web API client helpers

**Files:**
- Modify: `apps/web/lib/api.ts`

- [ ] **Step 1: Add form/search/attachment types + helpers**

Add an exported `FormFieldDef` type and extend the `catalog` object. Near `CatalogItem`:

```ts
export interface FormFieldDef {
  key: string;
  label: string;
  data_type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date' | 'user' | 'user_multi' | 'attachment';
  required: boolean;
  options: string[];
}
export interface CatalogForm {
  id: string;
  key: string;
  name: string;
  fields: FormFieldDef[];
}
export interface UserHit { id: string; display_name: string | null; email: string }
```

Replace the `catalog` export with:

```ts
export const catalog = {
  list: () => api.get<{ data: CatalogItem[] }>('/catalog'),
  form: (key: string) => api.get<{ form: CatalogForm | null }>(`/catalog/${key}/form`),
  request: (
    key: string,
    body: { subject?: string; description?: string; organizationId?: string; answers?: Record<string, unknown> },
  ) => api.post<Ticket>(`/catalog/${key}/request`, body),
};
```

Add a `users.search` helper and an `attachments.upload` helper (multipart — uses raw fetch, not the JSON `request`). Add near the other helpers:

```ts
export const users = {
  search: (q: string, organizationId?: string) =>
    api.get<{ data: UserHit[] }>(
      `/users/search?q=${encodeURIComponent(q)}${organizationId ? `&organizationId=${organizationId}` : ''}`,
    ),
};

export const attachmentsApi = {
  /** Multipart upload — the attachments route reads a single file field. */
  upload: async (ticketId: string, file: File): Promise<void> => {
    const form = new FormData();
    form.append('file', file);
    const token = getToken();
    const res = await fetch(`${BASE}/tickets/${ticketId}/attachments`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = res.statusText;
      try { detail = JSON.parse(text)?.detail ?? detail; } catch { /* ignore */ }
      throw new ApiError(res.status, detail);
    }
  },
};
```

- [ ] **Step 2: Typecheck the web app**

Run (from repo root): `npm run typecheck`
Expected: clean (web typecheck is part of the workspace typecheck).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): api client — catalog.form, users.search, attachment upload"
```

---

## Task 8: `UserPicker` component

**Files:**
- Create: `apps/web/components/user-picker.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client';
import * as React from 'react';
import { users, type UserHit } from '@/lib/api';
import { Input } from '@/components/ui/primitives';

// Single- or multi-select people picker backed by GET /users/search (org-scoped).
// `value` holds selected user id(s); `onChange` returns the same shape.
export function UserPicker({
  value,
  onChange,
  organizationId,
  multiple = false,
  placeholder = 'Enter name or email…',
}: {
  value: string | string[] | null;
  onChange: (v: string | string[] | null) => void;
  organizationId?: string;
  multiple?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = React.useState('');
  const [hits, setHits] = React.useState<UserHit[]>([]);
  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<Record<string, UserHit>>({});

  const selectedIds: string[] = Array.isArray(value) ? value : value ? [value] : [];

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      users.search(q, organizationId).then((r) => setHits(r.data)).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, organizationId]);

  function pick(u: UserHit) {
    setChosen((c) => ({ ...c, [u.id]: u }));
    if (multiple) {
      if (!selectedIds.includes(u.id)) onChange([...selectedIds, u.id]);
    } else {
      onChange(u.id);
      setOpen(false);
    }
    setQ('');
  }
  function remove(id: string) {
    if (multiple) onChange(selectedIds.filter((x) => x !== id));
    else onChange(null);
  }
  const label = (id: string) => chosen[id]?.display_name || chosen[id]?.email || id;

  return (
    <div className="relative">
      {selectedIds.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {selectedIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
              {label(id)}
              <button type="button" className="text-muted hover:text-fg" onClick={() => remove(id)}>×</button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={q}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
      />
      {open && hits.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-surface shadow-lg">
          {hits.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-surface-2"
                onClick={() => pick(u)}
              >
                <span className="text-sm text-fg">{u.display_name ?? u.email}</span>
                <span className="text-xs text-muted">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run (repo root): `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/user-picker.tsx
git commit -m "feat(web): UserPicker people-picker component"
```

---

## Task 9: Dynamic form in the catalog modal

**Files:**
- Modify: `apps/web/app/(app)/catalog/page.tsx`

- [ ] **Step 1: Fetch the form and branch the modal**

In `RequestModal`, add imports at the top of the file:

```ts
import { catalog, users, attachmentsApi, type CatalogForm, type FormFieldDef } from '@/lib/api';
import { UserPicker } from '@/components/user-picker';
```

(Adjust the existing `import { api, catalog, ... }` line so `catalog` isn't imported twice; keep one import.)

Replace the body of `RequestModal` with a version that loads the form and renders dynamically. Full component:

```tsx
function RequestModal({
  item, orgs, isAgent, onClose, onCreated,
}: {
  item: CatalogItem;
  orgs: Array<{ id: string; name: string }>;
  isAgent: boolean;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const { me } = useAuth();
  const [form, setForm] = React.useState<CatalogForm | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [orgId, setOrgId] = React.useState(orgs[0]?.id ?? '');
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({});
  const [file, setFile] = React.useState<File | null>(null);
  // legacy generic-modal state (used when there is no form)
  const [subject, setSubject] = React.useState(item.name);
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    catalog.form(item.key).then((r) => setForm(r.form)).catch(() => setForm(null)).finally(() => setLoaded(true));
  }, [item.key]);

  const searchOrg = isAgent ? orgId : me?.organization_id ?? undefined;
  const set = (key: string, v: unknown) => setAnswers((a) => ({ ...a, [key]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = form
        ? { organizationId: isAgent ? orgId : undefined, answers }
        : { subject, description, organizationId: isAgent ? orgId : undefined };
      const t = await catalog.request(item.key, body);
      if (file) await attachmentsApi.upload(t.id, file);
      onCreated(t);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not submit request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader><CardTitle>{item.name}</CardTitle></CardHeader>
        <CardBody>
          {form && <p className="mb-4 text-xs text-muted">Required fields are marked with an asterisk<span className="text-danger">*</span></p>}
          <form onSubmit={submit}>
            {isAgent && (
              <Field label="Customer organization">
                <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            )}

            {!loaded && <p className="text-xs text-muted">Loading…</p>}

            {loaded && form && form.fields.map((f) => (
              <Field key={f.key} label={f.required ? `${f.label} *` : f.label}>
                {f.data_type === 'textarea' ? (
                  <Textarea value={(answers[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                ) : f.data_type === 'select' ? (
                  <Select value={(answers[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="" disabled>Select…</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ) : f.data_type === 'checkbox' ? (
                  <input type="checkbox" checked={!!answers[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
                ) : f.data_type === 'user' ? (
                  <UserPicker value={(answers[f.key] as string) ?? null} onChange={(v) => set(f.key, v)} organizationId={searchOrg} />
                ) : f.data_type === 'user_multi' ? (
                  <UserPicker value={(answers[f.key] as string[]) ?? []} onChange={(v) => set(f.key, v)} organizationId={searchOrg} multiple />
                ) : f.data_type === 'attachment' ? (
                  <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted">
                    <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    {file && <span className="ml-2 text-fg">{file.name}</span>}
                  </div>
                ) : (
                  <Input
                    value={(answers[f.key] as string) ?? ''}
                    placeholder={f.key === 'summary' ? 'e.g. Create an account on Jira' : undefined}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </Field>
            ))}

            {loaded && !form && (
              <>
                <Field label="Subject">
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} />
                </Field>
                <Field label="Details">
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Anything the fulfilling tier should know…" />
                </Field>
              </>
            )}

            {error && <p className="mb-3 text-xs text-danger">{error}</p>}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
```

(Remove the old `subject`/`description`-only `RequestModal` body this replaces. Keep the rest of the file — `CatalogPage`, grouping, card grid — unchanged.)

- [ ] **Step 2: Typecheck**

Run (repo root): `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/(app)/catalog/page.tsx
git commit -m "feat(web): dynamic request form in catalog modal (pickers, system, attachment)"
```

---

## Task 10: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app and open the form**

Run (repo root): `npm run dev`. Sign in (dev login), open `/catalog`, click **Request** on "New user creation & provisioning". Confirm the form shows: on-behalf-of picker, Summary (placeholder "e.g. Create an account on Jira"), Select a system, Tell us why, Manager, Approvers, Attachment, and a **Send** button.

- [ ] **Step 2: Submit a request**

Pick an on-behalf-of user (type a name/email — results appear), fill Summary + system, optionally pick approvers and attach a file, click **Send**. Expected: redirect to the new ticket page; no error.

- [ ] **Step 3: Verify the ticket**

Confirm via DB (or the ticket page) that the ticket has: subject = your Summary, `requester_id` = the on-behalf-of user, `custom_fields` includes the system, an approval with one step per approver, and the attachment listed.

```bash
DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus node -e "import('pg').then(async({default:pg})=>{const c=new pg.Client(process.env.DATABASE_URL);await c.connect();const t=(await c.query(\"select id,subject,requester_id,custom_fields from tickets order by created_at desc limit 1\")).rows[0];console.log('ticket:',t.subject,t.requester_id,JSON.stringify(t.custom_fields));const a=await c.query('select count(*)::int n from approval_steps s join approvals ap on ap.id=s.approval_id where ap.subject_id=$1',[t.id]);console.log('approval steps:',a.rows[0].n);await c.end()})"
```

- [ ] **Step 4: Confirm the generic modal still works**

Open **Request** on a catalog item with no form (e.g. "Password reset"). Expected: the original Subject/Details modal appears and still creates a ticket.

---

## Final verification

- [ ] `cd apps/api && npm run typecheck && npm test` — green (note: an unrelated `pdp.test.ts`/concurrent failure is not from this work).
- [ ] Repo-root `npm run typecheck` — web + api clean.
- [ ] Each tier is independently shippable: T1 (form fetch + search), T2 (API creates correct ticket), T3 (UI).

## Spec coverage map

| Spec section | Task(s) |
|--------------|---------|
| §1 Schema (form_key, types, maps_to, seed) | 1 |
| §2 Backend: validation/types | 2 |
| §2 Backend: GET /catalog/:key/form | 3 |
| §2 Backend: GET /users/search | 4 |
| §2 Backend: submit routing + approval steps | 5, 6 |
| §3 Web: api client | 7 |
| §3 Web: UserPicker | 8 |
| §3 Web: dynamic renderer + layout + attachment | 9 |
| §4 Validation & errors | 2, 6, 9 |
| §5 Testing | 2, 4, 5; 10 (manual web) |

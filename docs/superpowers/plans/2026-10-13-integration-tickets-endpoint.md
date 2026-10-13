# Strict Integration Ticket Endpoint (Phase A′) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/v1/integration/tickets` — a strict-parsed sibling of `POST /api/v1/tickets` that accepts the external GRC consumer's payload field names, refuses an unrecognised field with a `422` instead of silently dropping it, and persists `dueDate` / `owner` / `controlIds` / `carbonUrl` / `sourceId` in real columns.

**Architecture:** One create path. `tickets.createTicket` keeps all persistence and gains a nested `integration?` input group; the SLA/triage stamp is extracted into `stampSlaAndTriage` so the clock can be suppressed. A new `modules/integration-tickets.ts` holds the contract and nothing else — strict-parse, rename to Anchor's vocabulary, serialize — so almost every rule is unit-testable without a database. The route is four lines.

**Tech Stack:** TypeScript (NodeNext, explicit `.js` import specifiers), Fastify 5, zod 3.23, Postgres via `pg` with RLS org-context, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-10-13-integration-tickets-endpoint-design.md`

## Global Constraints

- Migrations are **forward-only** (ADR-0003). New file: `apps/api/src/db/migrations/0081_integration_ticket_fields.sql`. Never edit an applied migration.
- Source imports use explicit `.js` specifiers even for `.ts` files (e.g. `import { x } from './tickets.js'`). Vitest resolves these via the `js-to-ts` plugin in `apps/api/vitest.config.ts`.
- All errors are RFC 7807 via `Errors.*` (ADR-0015). `Errors.validation(detail, errors[])` = **422**, `Errors.forbidden` = **403**. Do not introduce new error machinery.
- New column names are **vendor-neutral**: `external_url`, not `carbon_url`.
- **Integration tests skip silently without `DATABASE_URL`.** `apps/api/test/helpers/db.ts` makes `describeDb` into `describe.skip` when it is unset, so the suite reports green having run nothing. Every test command in this plan loads the root `.env` first. The dev database is on host port **5544**, not 5432.
- Use `DATABASE_URL` (owner role), never `APP_DATABASE_URL` — the latter is RLS-restricted and returns empty results.
- Do not touch the `apps/api/src/*  2/` directories (`db 2`, `modules 2`, …). They are iCloud sync artifacts, not source.
- `severity` on tickets is free-form nullable text in the applied schema. The `CHECK (severity IN ('Sev1'…))` in `docs/nexus/artifacts/db/schema.sql` is stale and does not exist in the database.

## Review Focus

1. **`dueDate: null` sent explicitly must clear `external_due_at`**, not keep the previous deadline — an absent key and an explicit null are different intentions, and `??` collapses them. (Task 3)
2. **`controlIds: []` sent explicitly must clear the array**, while omitting the key preserves it. Same absent-vs-empty distinction. (Task 3)
3. **An `externalRef` of 201 characters must be a `422`**, not a Postgres length or constraint error leaking as a 500. (Task 4)
4. **Two concurrent first-syncs of the same `externalRef` must resolve to one ticket**, not a 500 — `createTicket` does SELECT-then-INSERT, so both can miss and one loses to `ux_tickets_org_external_ref`. (Task 5)
5. **A `metadata` key an admin flagged `sensitive` must surface as the existing `422`** through the new route, not a 500. (Task 5)

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/migrations/0081_integration_ticket_fields.sql` (create) | the five typed columns + GIN index |
| `apps/api/src/modules/tickets.ts` (modify) | `stampSlaAndTriage` extraction; `integration?` input group; persist/refresh the five columns |
| `apps/api/src/modules/integration-tickets.ts` (create) | the contract: strict parse, rename, serialize, conflict retry |
| `apps/api/src/http/routes-extra.ts` (modify) | route registration |
| `apps/api/test/integration-tickets.test.ts` (create) | DB-free unit tests: parse tiers, severity map, ignored[], serializer, conflict predicate |
| `apps/api/test/sla-suppression.test.ts` (create) | DB-free unit test: suppressed clock writes no `sla_instances` |
| `apps/api/test/integration/integration-tickets.int.test.ts` (create) | DB-backed: persistence, upsert identity, non-clobber, 403, sensitive-key 422, round-trip |

---

### Task 1: Migration — five integration columns

**Files:**
- Create: `apps/api/src/db/migrations/0081_integration_ticket_fields.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `tickets.external_due_at timestamptz`, `tickets.external_owner text`, `tickets.external_source_id text`, `tickets.control_ids text[] NOT NULL DEFAULT '{}'`, `tickets.external_url text`; index `ix_tickets_control_ids`.

- [ ] **Step 1: Write the migration**

```sql
-- Typed homes for the external GRC integration's item fields (ADR-0016, phase A').
-- Before this, POST /api/v1/tickets' non-strict zod schema dropped dueDate/owner/controlIds/
-- sourceId/carbonUrl on the floor and returned 201, so a caller could sync for months while
-- its due dates went nowhere. Names are deliberately vendor-neutral (external_url, not
-- carbon_url) so a second integration reuses them rather than adding its own column.
ALTER TABLE tickets
  ADD COLUMN external_due_at    timestamptz,
  ADD COLUMN external_owner     text,
  ADD COLUMN external_source_id text,
  ADD COLUMN control_ids        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN external_url       text;

-- external_due_at is the CALLER's remediation deadline. It is deliberately NOT
-- resolution_due_at, which is Anchor's SLA clock — conflating them would corrupt SLA
-- reporting and mislead the caller about which deadline it is reading.
COMMENT ON COLUMN tickets.external_due_at IS
  'Remediation deadline supplied by an external integration; distinct from the SLA clock.';

-- external_source_id is the caller's own id for the underlying item: a stable handle that
-- survives a change to the external_ref string format (which the consumer duplicates on
-- their side and warns may change).
COMMENT ON COLUMN tickets.external_source_id IS
  'The external system''s id for the source item, independent of external_ref formatting.';

-- "Which tickets touch CA-7?" is a real GRC reporting question, which is why control ids are
-- a queryable array rather than tags (a user-facing labelling field with other semantics).
CREATE INDEX ix_tickets_control_ids ON tickets USING gin(control_ids);
```

No `seed.ts` dual-write is needed (ADR-0003's rule): these columns are integration-populated and no seeded row sets them.

- [ ] **Step 2: Apply it**

```bash
cd /Users/kevinwhite/Developer/NexusCyber_Support
set -a; . ./.env; set +a
npm --workspace apps/api run migrate
```
Expected: the runner reports `0081_integration_ticket_fields.sql` applied, with no error.

- [ ] **Step 3: Verify the columns and index exist**

```bash
set -a; . ./.env; set +a
node -e "
const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});
c.connect().then(async()=>{
  const cols=await c.query(\"SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='tickets' AND column_name IN ('external_due_at','external_owner','external_source_id','control_ids','external_url') ORDER BY column_name\");
  console.table(cols.rows);
  const ix=await c.query(\"SELECT indexname FROM pg_indexes WHERE tablename='tickets' AND indexname='ix_tickets_control_ids'\");
  console.log('index rows:',ix.rowCount);
  await c.end();
});"
```
Expected: 5 rows; `control_ids` shows `is_nullable = NO` and default `'{}'::text[]`; index rows: 1.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/migrations/0081_integration_ticket_fields.sql
git commit -m "feat(db): typed columns for external integration ticket fields

Five vendor-neutral columns so the GRC integration's dueDate, owner,
controlIds, sourceId and carbonUrl have real homes instead of being
stripped by a non-strict schema or buried in custom_fields. ADR-0016.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract `stampSlaAndTriage` with clock suppression

**Files:**
- Modify: `apps/api/src/modules/tickets.ts` (the post-insert block that currently calls `startTicketSla` then stamps `status='triage'`)
- Test: `apps/api/test/sla-suppression.test.ts` (create)

**Interfaces:**
- Consumes: `startTicketSla(sql, ticket)` from `./sla.js` (unchanged).
- Produces: `export async function stampSlaAndTriage(sql: Sql, ticket: { id: string; organization_id: string; priority: string }, suppressSla?: boolean): Promise<{ response_due_at: Date | null; resolution_due_at: Date | null }>`

**Why this exists:** there is no configuration that stops a ticket's clock. `startTicketSla` writes `sla_instances` rows on every create path, its targets are hardcoded per derived priority in `targetMinutes`, and `sla_policies` is **never read by any module**. Suppression can only be a code parameter. Nothing sets it in this phase — it ships so phase D can switch it on for backlog items without reopening the create path.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/sla-suppression.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stampSlaAndTriage } from '../src/modules/tickets.js';

/** Minimal fake of the `Sql` surface: records every statement so a test can assert on what
 *  was NOT written. `business_calendars` returning no rows makes loadCalendar fall back to
 *  its 8x5 defaults, which is all we need. */
function fakeSql() {
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string) => {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
}

const ticket = { id: 't-1', organization_id: 'o-1', priority: 'P2' };

describe('stampSlaAndTriage', () => {
  it('starts both clocks by default', async () => {
    const sql = fakeSql();
    const due = await stampSlaAndTriage(sql as never, ticket);
    expect(sql.queries.filter((q) => /INSERT INTO sla_instances/i.test(q))).toHaveLength(2);
    expect(due.response_due_at).not.toBeNull();
    expect(due.resolution_due_at).not.toBeNull();
  });

  it('writes no sla_instances rows when suppressed', async () => {
    const sql = fakeSql();
    const due = await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /INSERT INTO sla_instances/i.test(q))).toBe(false);
    expect(due.response_due_at).toBeNull();
    expect(due.resolution_due_at).toBeNull();
  });

  it('still moves a suppressed ticket to triage', async () => {
    const sql = fakeSql();
    await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /UPDATE tickets SET status='triage'/i.test(q))).toBe(true);
  });

  it('does not stamp due dates when suppressed', async () => {
    const sql = fakeSql();
    await stampSlaAndTriage(sql as never, ticket, true);
    expect(sql.queries.some((q) => /response_due_at/i.test(q))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /Users/kevinwhite/Developer/NexusCyber_Support
npm --workspace apps/api run test -- test/sla-suppression.test.ts
```
Expected: FAIL — `stampSlaAndTriage` is not exported from `tickets.ts`.

- [ ] **Step 3: Implement it**

First, in `apps/api/src/modules/tickets.ts`, add the input group to `CreateTicketInput` — the
helper below reads `input.integration?.suppressSla`, so this task does not typecheck without it:

```ts
  /**
   * Typed fields from the external-integration contract (ADR-0016). Deliberately a nested
   * group rather than five loose parameters so the existing call sites stay readable, and
   * deliberately absent from the human-intake route's zod schema — only
   * modules/integration-tickets.ts populates it.
   *
   * Key PRESENCE is meaningful on an upsert: an absent key preserves the stored value, a
   * present `null` clears it. `??` cannot express that distinction, which is why the update
   * branch tests with `in`.
   */
  integration?: {
    dueAt?: string | null;
    owner?: string | null;
    controlIds?: string[];
    url?: string | null;
    sourceId?: string | null;
    suppressSla?: boolean;
  };
```

Then add after `nextTicketNumber`:

```ts
/**
 * Move a freshly inserted ticket to `triage` and start its SLA clocks.
 *
 * `suppressSla` serves integration items that are work records rather than service
 * commitments — a build-backlog story has an estimate, not a deadline. It has to be a
 * parameter because no configuration can do it: startTicketSla writes sla_instances on every
 * create path, targets are hardcoded per derived priority (targetMinutes), and sla_policies is
 * never read by any module. The status still moves to `triage`; only the clocks and the
 * due-date stamps are skipped.
 */
export async function stampSlaAndTriage(
  sql: Sql,
  ticket: { id: string; organization_id: string; priority: string },
  suppressSla = false,
): Promise<{ response_due_at: Date | null; resolution_due_at: Date | null }> {
  if (suppressSla) {
    await sql.query(`UPDATE tickets SET status='triage' WHERE id=$1`, [ticket.id]);
    return { response_due_at: null, resolution_due_at: null };
  }
  const due = await startTicketSla(sql, ticket);
  await sql.query(
    `UPDATE tickets SET response_due_at=$1, resolution_due_at=$2, status='triage' WHERE id=$3`,
    [due.response_due_at, due.resolution_due_at, ticket.id],
  );
  return due;
}
```

Then replace the existing post-insert block inside `createTicket`:

```ts
    const due = await startTicketSla(sql, ticket);
    await sql.query(
      `UPDATE tickets SET response_due_at=$1, resolution_due_at=$2, status='triage' WHERE id=$3`,
      [due.response_due_at, due.resolution_due_at, ticket.id],
    );
```

with:

```ts
    const due = await stampSlaAndTriage(sql, ticket, input.integration?.suppressSla ?? false);
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
npm --workspace apps/api run test -- test/sla-suppression.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/tickets.ts apps/api/test/sla-suppression.test.ts
git commit -m "refactor(tickets): extract stampSlaAndTriage with clock suppression

No configuration can stop a ticket's SLA clock: startTicketSla runs on
every create path, its targets are hardcoded per priority, and
sla_policies is never read. Suppression has to be a parameter. Nothing
sets it yet - phase D switches it on for backlog items.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Persist and refresh the five columns

**Files:**
- Modify: `apps/api/src/modules/tickets.ts` (`CreateTicketInput`, the upsert UPDATE, the INSERT)
- Test: `apps/api/test/integration/integration-tickets.int.test.ts` (create)

**Interfaces:**
- Consumes: `stampSlaAndTriage` (Task 2).
- Produces: `CreateTicketInput.integration?: { dueAt?: string | null; owner?: string | null; controlIds?: string[]; url?: string | null; sourceId?: string | null; suppressSla?: boolean }`. **Key presence is meaningful** — an absent key preserves the stored value, a present `null` clears it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/integration-tickets.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createTicket } from '../../src/modules/tickets.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

async function ticketRow(orgId: string, externalRef: string) {
  return withSystemContext(async (sql) =>
    (
      await sql.query(
        `SELECT id, ticket_number, status, assigned_agent_id, external_due_at, external_owner,
                external_source_id, control_ids, external_url, custom_fields
           FROM tickets WHERE organization_id=$1 AND external_ref=$2`,
        [orgId, externalRef],
      )
    ).rows[0],
  );
}

describeDb('integration ticket fields persist through create and upsert', () => {
  let agent: Principal;
  let orgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    orgId = await withSystemContext(
      async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id,
    );
  });

  it('persists all five integration columns on create', async () => {
    const externalRef = `int-create-${Date.now()}`;
    await createTicket(agent, {
      subject: 'POA&M remediation',
      organizationId: orgId,
      externalRef,
      externalSource: 'poam',
      integration: {
        dueAt: '2026-11-30T00:00:00.000Z',
        owner: 'Platform Team',
        sourceId: 'p-118',
        controlIds: ['CA-7', 'RA-5'],
        url: 'https://example.gov/applications/urn-1',
      },
    });

    const row = await ticketRow(orgId, externalRef);
    expect(new Date(row.external_due_at).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(row.external_owner).toBe('Platform Team');
    expect(row.external_source_id).toBe('p-118');
    expect(row.control_ids).toEqual(['CA-7', 'RA-5']);
    expect(row.external_url).toBe('https://example.gov/applications/urn-1');
  });

  it('never sets assigned_agent_id from owner', async () => {
    const externalRef = `int-owner-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Owner is text only',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'manager@nexus.example.com' },
    });
    const row = await ticketRow(orgId, externalRef);
    expect(row.external_owner).toBe('manager@nexus.example.com');
    expect(row.assigned_agent_id).toBeNull();
  });

  it('does not clobber status or assignee on re-sync', async () => {
    const externalRef = `int-noclobber-${Date.now()}`;
    const created = await createTicket(agent, {
      subject: 'Reopened finding',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'A' },
    });

    // Simulate Anchor taking ownership and moving the ticket.
    await withSystemContext(async (sql) => {
      await sql.query(
        `UPDATE tickets SET status='in_progress', assigned_agent_id=(SELECT id FROM users WHERE email='manager@nexus.example.com')
          WHERE id=$1`,
        [created.id],
      );
    });

    await createTicket(agent, {
      subject: 'Reopened finding (re-synced)',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'B' },
    });

    const row = await ticketRow(orgId, externalRef);
    expect(row.id).toBe(created.id);
    expect(row.ticket_number).toBe(created.ticket_number);
    expect(row.status).toBe('in_progress');      // Anchor owns the lifecycle
    expect(row.assigned_agent_id).not.toBeNull(); // Anchor owns the assignment
    expect(row.external_owner).toBe('B');         // the caller's text still refreshes
  });

  it('clears external_due_at when dueAt is explicitly null (Review Focus 1)', async () => {
    const externalRef = `int-null-due-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Due date withdrawn',
      organizationId: orgId,
      externalRef,
      integration: { dueAt: '2026-11-30T00:00:00.000Z' },
    });
    await createTicket(agent, {
      subject: 'Due date withdrawn',
      organizationId: orgId,
      externalRef,
      integration: { dueAt: null },
    });
    expect((await ticketRow(orgId, externalRef)).external_due_at).toBeNull();
  });

  it('preserves external_due_at when dueAt is absent (Review Focus 1)', async () => {
    const externalRef = `int-absent-due-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Due date kept',
      organizationId: orgId,
      externalRef,
      integration: { dueAt: '2026-11-30T00:00:00.000Z' },
    });
    await createTicket(agent, {
      subject: 'Due date kept',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'unchanged' },
    });
    const row = await ticketRow(orgId, externalRef);
    expect(new Date(row.external_due_at).toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });

  it('clears control_ids on an explicit empty array but preserves it when absent (Review Focus 2)', async () => {
    const externalRef = `int-controls-${Date.now()}`;
    await createTicket(agent, {
      subject: 'Controls',
      organizationId: orgId,
      externalRef,
      integration: { controlIds: ['CA-7'] },
    });

    await createTicket(agent, {
      subject: 'Controls',
      organizationId: orgId,
      externalRef,
      integration: { owner: 'x' },
    });
    expect((await ticketRow(orgId, externalRef)).control_ids).toEqual(['CA-7']);

    await createTicket(agent, {
      subject: 'Controls',
      organizationId: orgId,
      externalRef,
      integration: { controlIds: [] },
    });
    expect((await ticketRow(orgId, externalRef)).control_ids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /Users/kevinwhite/Developer/NexusCyber_Support
set -a; . ./.env; set +a
npm --workspace apps/api run test -- test/integration/integration-tickets.int.test.ts
```
Expected: FAIL (a TypeScript/runtime error on the unknown `integration` property). **If you instead see "7 skipped", the `.env` did not load — fix that before continuing, or every later verification is meaningless.**

- [ ] **Step 3: Confirm the input group**

Task 2 already added this to `CreateTicketInput` in `apps/api/src/modules/tickets.ts`. Verify it
is present and matches exactly before going further — the `in` checks in Step 4 depend on the
optional-key shape:

```ts
  integration?: {
    dueAt?: string | null;
    owner?: string | null;
    controlIds?: string[];
    url?: string | null;
    sourceId?: string | null;
    suppressSla?: boolean;
  };
```

- [ ] **Step 4: Refresh the five columns in the upsert branch**

Replace the `UPDATE tickets SET subject=$2, …` statement and its parameter array with:

```ts
        const ig = input.integration ?? {};
        const { rows: updated } = await sql.query(
          `UPDATE tickets
              SET subject=$2, description=$3, category=$4, impact=$5, urgency=$6, priority=$7, tags=$8,
                  severity=$9, custom_fields=$10, external_due_at=$11, external_owner=$12,
                  external_source_id=$13, control_ids=$14, external_url=$15
            WHERE id=$1 RETURNING *`,
          [
            existing.id,
            input.subject,
            input.description ?? existing.description,
            input.category ?? existing.category,
            impact,
            urgency,
            priority,
            input.tags ?? existing.tags,
            input.severity ?? existing.severity,
            input.customFields ?? existing.custom_fields,
            // `in` not `??`: an explicit null withdraws a deadline, an absent key keeps it.
            'dueAt' in ig ? ig.dueAt : existing.external_due_at,
            'owner' in ig ? ig.owner : existing.external_owner,
            'sourceId' in ig ? ig.sourceId : existing.external_source_id,
            'controlIds' in ig ? ig.controlIds : existing.control_ids,
            'url' in ig ? ig.url : existing.external_url,
          ],
        );
```

This statement deliberately does **not** list `status`, `assigned_agent_id` or `ticket_number`: the consumer's contract makes Anchor the owner of the lifecycle and the assignment, so a re-sync must not move a ticket an agent has picked up.

- [ ] **Step 5: Persist them on insert**

Replace the `INSERT INTO tickets (…)` column list, `VALUES` list and parameter array with:

```ts
    const ticketNumber = await nextTicketNumber(sql, orgId);
    const ig = input.integration ?? {};
    const { rows } = await sql.query(
      `INSERT INTO tickets
         (organization_id, ticket_number, type, requester_id, affected_user_id, source_channel,
          subject, description, category, service_id, impact, urgency, priority, status, tags,
          external_ref, external_source, severity, custom_fields,
          external_due_at, external_owner, external_source_id, control_ids, external_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new',$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23)
       RETURNING *`,
      [
        orgId,
        ticketNumber,
        input.type ?? 'incident',
        actor.plane === 'customer' ? actor.id : null,
        input.affectedUserId ?? (actor.plane === 'customer' ? actor.id : null),
        actor.plane === 'customer' ? 'portal' : 'agent',
        input.subject,
        input.description ?? null,
        input.category ?? null,
        input.serviceId ?? null,
        impact,
        urgency,
        priority,
        input.tags ?? [],
        input.externalRef ?? null,
        input.externalSource ?? null,
        input.severity ?? null,
        input.customFields ?? {},
        ig.dueAt ?? null,
        ig.owner ?? null,
        ig.sourceId ?? null,
        ig.controlIds ?? [],
        ig.url ?? null,
      ],
    );
```

Note the existing `ig` declaration in Step 4 is inside the upsert branch; this one is in the insert path. Two `const ig` in different blocks is fine.

- [ ] **Step 6: Run the tests and make sure they pass**

```bash
set -a; . ./.env; set +a
npm --workspace apps/api run test -- test/integration/integration-tickets.int.test.ts
```
Expected: 7 passed, 0 skipped.

- [ ] **Step 7: Run the whole API suite for regressions**

```bash
set -a; . ./.env; set +a
npm --workspace apps/api run test
```
Expected: all green. `createTicket` is shared by the portal, agent UI, catalog and mail-ingest paths, so this is the run that matters.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/tickets.ts apps/api/test/integration/integration-tickets.int.test.ts
git commit -m "feat(tickets): persist external integration fields on create and upsert

Key presence is meaningful: an absent key preserves the stored value, an
explicit null clears it, so the upsert tests with 'in' rather than '??'.
The update statement still omits status, assigned_agent_id and
ticket_number - Anchor owns the lifecycle and the assignment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The contract module — strict parse, rename, severity map

**Files:**
- Create: `apps/api/src/modules/integration-tickets.ts`
- Test: `apps/api/test/integration-tickets.test.ts` (create)

**Interfaces:**
- Consumes: `CreateTicketInput` (Task 3), `Errors` from `../errors.js`.
- Produces:
  - `SEVERITY_TO_IMPACT_URGENCY: Record<string, [number, number]>`
  - `parseIntegrationTicket(raw: unknown): { input: CreateTicketInput; ignored: string[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration-tickets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseIntegrationTicket } from '../src/modules/integration-tickets.js';
import { ApiError } from '../src/errors.js';

const ORG = '5793f502-0000-4000-8000-000000000001';

function payload(over: Record<string, unknown> = {}) {
  return {
    externalRef: 'carbon-conmon:poam:p-118',
    organizationId: ORG,
    source: 'poam',
    title: 'Patch CVE-2026-1234 on the web tier',
    ...over,
  };
}

describe('parseIntegrationTicket — renaming', () => {
  it('maps the consumer vocabulary onto Anchor field names', () => {
    const { input } = parseIntegrationTicket(
      payload({
        description: 'KEV-listed',
        labels: ['poam', 'grc'],
        metadata: { carbonFindingId: 'f-1' },
        sourceId: 'p-118',
        owner: 'Platform Team',
        controlIds: ['CA-7'],
        dueDate: '2026-11-30T00:00:00Z',
        carbonUrl: 'https://example.gov/a/1',
      }),
    );
    expect(input.subject).toBe('Patch CVE-2026-1234 on the web tier');
    expect(input.externalSource).toBe('poam');
    expect(input.tags).toEqual(['poam', 'grc']);
    expect(input.customFields).toEqual({ carbonFindingId: 'f-1' });
    expect(input.integration).toMatchObject({
      sourceId: 'p-118',
      owner: 'Platform Team',
      controlIds: ['CA-7'],
      url: 'https://example.gov/a/1',
    });
    expect(input.integration?.dueAt).toBe('2026-11-30T00:00:00Z');
  });

  it('omits integration keys the caller did not send, so an upsert preserves them', () => {
    const { input } = parseIntegrationTicket(payload({ owner: 'A' }));
    expect('owner' in (input.integration ?? {})).toBe(true);
    expect('dueAt' in (input.integration ?? {})).toBe(false);
    expect('controlIds' in (input.integration ?? {})).toBe(false);
  });

  it('keeps an explicit null so the upsert can clear the column', () => {
    const { input } = parseIntegrationTicket(payload({ dueDate: null }));
    expect('dueAt' in (input.integration ?? {})).toBe(true);
    expect(input.integration?.dueAt).toBeNull();
  });
});

describe('parseIntegrationTicket — severity drives priority', () => {
  it.each([
    ['critical', 1, 1],
    ['high', 2, 2],
    ['medium', 3, 3],
    ['low', 4, 4],
  ])('maps %s to impact/urgency %i/%i', (severity, impact, urgency) => {
    const { input } = parseIntegrationTicket(payload({ severity }));
    expect(input.impact).toBe(impact);
    expect(input.urgency).toBe(urgency);
    expect(input.severity).toBe(severity);
  });

  it('defaults a null severity to 3/3 and stores no severity', () => {
    const { input } = parseIntegrationTicket(payload({ severity: null }));
    expect(input.impact).toBe(3);
    expect(input.urgency).toBe(3);
    expect(input.severity).toBeUndefined();
  });
});

describe('parseIntegrationTicket — the three tiers', () => {
  it('reports status, priority and tenantId as ignored rather than dropping them', () => {
    const { ignored } = parseIntegrationTicket(
      payload({ status: 'open', priority: 'P0', tenantId: null }),
    );
    expect(ignored.sort()).toEqual(['priority', 'status', 'tenantId']);
  });

  it('reports nothing as ignored when none were sent', () => {
    expect(parseIntegrationTicket(payload()).ignored).toEqual([]);
  });

  it('refuses an unrecognised field with a 422 naming it', () => {
    try {
      parseIntegrationTicket(payload({ wobble: 1 }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(422);
      expect(e.errors?.map((x) => x.field)).toContain('wobble');
    }
  });

  it('refuses a phase-D backlog field and says so', () => {
    try {
      parseIntegrationTicket(payload({ parentExternalRef: 'carbon-conmon:backlog:WS-1' }));
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as ApiError;
      expect(e.status).toBe(422);
      expect(e.errors?.[0].field).toBe('parentExternalRef');
      expect(e.detail).toMatch(/phase D/i);
    }
  });
});

describe('parseIntegrationTicket — required and bounded fields', () => {
  it('requires title, externalRef and organizationId', () => {
    const e = (() => {
      try {
        parseIntegrationTicket({ source: 'poam' });
      } catch (err) {
        return err as ApiError;
      }
    })();
    expect(e?.status).toBe(422);
    const fields = e?.errors?.map((x) => x.field) ?? [];
    expect(fields).toContain('title');
    expect(fields).toContain('externalRef');
    expect(fields).toContain('organizationId');
  });

  it('accepts an externalRef whose first segment is not a uuid', () => {
    const { input } = parseIntegrationTicket(payload({ externalRef: 'carbon-conmon:backlog:WS-1.1' }));
    expect(input.externalRef).toBe('carbon-conmon:backlog:WS-1.1');
  });

  it('refuses a 201-character externalRef with a 422 (Review Focus 3)', () => {
    const e = (() => {
      try {
        parseIntegrationTicket(payload({ externalRef: 'x'.repeat(201) }));
      } catch (err) {
        return err as ApiError;
      }
    })();
    expect(e?.status).toBe(422);
    expect(e?.errors?.map((x) => x.field)).toContain('externalRef');
  });

  it('refuses a non-object body', () => {
    expect(() => parseIntegrationTicket('nope')).toThrow(ApiError);
    expect(() => parseIntegrationTicket(null)).toThrow(ApiError);
    expect(() => parseIntegrationTicket([])).toThrow(ApiError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm --workspace apps/api run test -- test/integration-tickets.test.ts
```
Expected: FAIL — cannot resolve `../src/modules/integration-tickets.js`.

- [ ] **Step 3: Write the module**

Create `apps/api/src/modules/integration-tickets.ts`:

```ts
// The external-integration ticket contract (ADR-0016, phase A'). This module IS the contract:
// it strict-parses the caller's payload, renames its vocabulary to Anchor's, and serializes the
// reply. It holds no persistence logic — tickets.createTicket does all of that — so every rule
// here is unit-testable without a database.
//
// Why a separate module and route at all: POST /api/v1/tickets is simultaneously the agent UI,
// customer portal, service-catalog and mail-ingest intake path. Its zod schema is non-strict,
// so an unknown field is stripped and the call still returns 201 — a caller can sync for months
// while its due dates go nowhere. That route cannot be made strict without breaking the human
// paths, so the integration gets its own.
import { z } from 'zod';
import { Errors } from '../errors.js';
import type { CreateTicketInput } from './tickets.js';

/**
 * Fields the caller sends that Anchor accepts syntactically but cannot apply:
 * - `status` — Anchor owns the lifecycle; status moves only through /transition.
 * - `priority` — Anchor DERIVES priority from impact x urgency; there is no P0.
 * - `tenantId` — Anchor has no tenant concept; organizations are the only boundary.
 *
 * These are reported in the response's `ignored[]` rather than refused, because the caller's
 * documented payload always carries them and a 422 would reject every conformant request
 * forever. Reporting them is the middle path between that and the silent drop this module
 * exists to eliminate.
 */
const NOT_APPLIED = ['status', 'priority', 'tenantId'] as const;

/** Phase-D backlog fields. Refused loudly, so a caller is never told that backlog metadata
 *  landed when it did not. */
const DEFERRED = [
  'parentExternalRef',
  'estimateDays',
  'phase',
  'workstream',
  'acceptanceCriteria',
  'blockedReason',
] as const;

/** The published contract's severity mapping. Applied server-side here (unlike
 *  POST /api/v1/tickets, which stores severity descriptively and ignores it for priority) so
 *  the caller does not have to compute Anchor's impact/urgency itself. */
export const SEVERITY_TO_IMPACT_URGENCY: Record<string, [number, number]> = {
  critical: [1, 1],
  high: [2, 2],
  medium: [3, 3],
  low: [4, 4],
};

const payloadSchema = z
  .object({
    externalRef: z.string().min(1).max(200),
    organizationId: z.string().uuid(),
    source: z.string().min(1).max(60),
    title: z.string().min(3).max(300),
    description: z.string().max(20_000).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
    sourceId: z.string().max(200).nullable().optional(),
    owner: z.string().max(200).nullable().optional(),
    controlIds: z.array(z.string().max(60)).max(200).optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
    labels: z.array(z.string().max(60)).max(100).optional(),
    carbonUrl: z.string().url().max(2000).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    // Accepted, never applied — see NOT_APPLIED.
    status: z.string().max(40).optional(),
    priority: z.string().max(8).nullable().optional(),
    tenantId: z.string().max(200).nullable().optional(),
  })
  .strict();

/** Flatten a ZodError into the RFC 7807 `errors[]` shape (ADR-0015). An unrecognised key is
 *  reported under its own name, because "unrecognized_keys" on the body tells an operator that
 *  something was wrong but not which field. */
function zodFieldErrors(err: z.ZodError): Array<{ field: string; message: string }> {
  return err.issues.flatMap((i) =>
    i.code === 'unrecognized_keys'
      ? (i as z.ZodIssue & { keys: string[] }).keys.map((k) => ({ field: k, message: 'unrecognized field' }))
      : [{ field: i.path.join('.') || '(body)', message: i.message }],
  );
}

/**
 * Strict-parse an integration payload into a `CreateTicketInput`.
 *
 * The returned `integration` group carries ONLY the keys the caller actually sent: the upsert
 * path distinguishes an absent key (preserve the stored value) from a present null (clear it),
 * and collapsing them would make a withdrawn due date impossible to express.
 */
export function parseIntegrationTicket(raw: unknown): { input: CreateTicketInput; ignored: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw Errors.validation('body must be a JSON object');
  }
  const src = raw as Record<string, unknown>;

  const deferred = Object.keys(src).filter((k) => (DEFERRED as readonly string[]).includes(k));
  if (deferred.length) {
    throw Errors.validation(
      'backlog fields are not supported yet (phase D)',
      deferred.map((field) => ({ field, message: 'not supported until phase D (backlog import)' })),
    );
  }

  const parsed = payloadSchema.safeParse(src);
  if (!parsed.success) {
    throw Errors.validation('invalid integration ticket payload', zodFieldErrors(parsed.error));
  }
  const b = parsed.data;

  const [impact, urgency] = SEVERITY_TO_IMPACT_URGENCY[b.severity ?? ''] ?? [3, 3];

  const integration: NonNullable<CreateTicketInput['integration']> = {};
  if ('dueDate' in src) integration.dueAt = b.dueDate ?? null;
  if ('owner' in src) integration.owner = b.owner ?? null;
  if ('sourceId' in src) integration.sourceId = b.sourceId ?? null;
  if ('controlIds' in src) integration.controlIds = b.controlIds ?? [];
  if ('carbonUrl' in src) integration.url = b.carbonUrl ?? null;

  return {
    ignored: NOT_APPLIED.filter((k) => k in src),
    input: {
      subject: b.title,
      description: b.description,
      organizationId: b.organizationId,
      externalRef: b.externalRef,
      externalSource: b.source,
      severity: b.severity ?? undefined,
      impact,
      urgency,
      tags: b.labels,
      customFields: b.metadata,
      integration,
    },
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
npm --workspace apps/api run test -- test/integration-tickets.test.ts
```
Expected: all passed (18 assertions across 13 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/integration-tickets.ts apps/api/test/integration-tickets.test.ts
git commit -m "feat(integration): strict-parsed ticket contract module

Three tiers rather than two: applied, accepted-but-reported in ignored[],
and refused with a 422. status/priority/tenantId cannot be applied but
appear in every conformant payload, so refusing them would reject every
request; dropping them silently is the hazard this module exists to kill.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Serializer, orchestration, conflict retry, route

**Files:**
- Modify: `apps/api/src/modules/integration-tickets.ts`
- Modify: `apps/api/src/http/routes-extra.ts`
- Test: `apps/api/test/integration-tickets.test.ts` (append), `apps/api/test/integration/integration-tickets.int.test.ts` (append)

**Interfaces:**
- Consumes: `parseIntegrationTicket` (Task 4), `tickets.createTicket` (Task 3).
- Produces:
  - `IntegrationTicketResponse` — `{ ticketId, ticketKey, externalRef, status, assignee, dueDate, createdAt, updatedAt, created, ignored }`
  - `serializeIntegrationTicket(row, created, ignored, assignee): IntegrationTicketResponse`
  - `isExternalRefConflict(err: unknown): boolean`
  - `upsertIntegrationTicket(actor: Principal, raw: unknown): Promise<{ created: boolean; body: IntegrationTicketResponse }>`

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/test/integration-tickets.test.ts`:

```ts
import { serializeIntegrationTicket, isExternalRefConflict } from '../src/modules/integration-tickets.js';

describe('serializeIntegrationTicket', () => {
  const row = {
    id: 'a1', ticket_number: 'DEMO-000123', external_ref: 'carbon-conmon:poam:p-118',
    status: 'triage', external_due_at: new Date('2026-11-30T00:00:00Z'),
    created_at: new Date('2026-10-13T10:00:00Z'), updated_at: new Date('2026-10-13T10:00:01Z'),
  };

  it('exposes the integration shape, not the ticket row', () => {
    const out = serializeIntegrationTicket(row, true, ['status'], null);
    expect(out).toEqual({
      ticketId: 'a1',
      ticketKey: 'DEMO-000123',
      externalRef: 'carbon-conmon:poam:p-118',
      status: 'triage',
      assignee: null,
      dueDate: '2026-11-30T00:00:00.000Z',
      createdAt: '2026-10-13T10:00:00.000Z',
      updatedAt: '2026-10-13T10:00:01.000Z',
      created: true,
      ignored: ['status'],
    });
  });

  it('echoes the caller due date, never the SLA clock', () => {
    const out = serializeIntegrationTicket(
      { ...row, external_due_at: null, resolution_due_at: new Date('2026-10-14T00:00:00Z') },
      false, [], null,
    );
    expect(out.dueDate).toBeNull();
  });

  it('reports the assignee it was given', () => {
    expect(serializeIntegrationTicket(row, false, [], 'a@example.gov').assignee).toBe('a@example.gov');
  });
});

describe('isExternalRefConflict', () => {
  it('recognises the unique-index violation on external_ref', () => {
    expect(isExternalRefConflict({ code: '23505', constraint: 'ux_tickets_org_external_ref' })).toBe(true);
  });

  it('ignores other unique violations and non-pg errors', () => {
    expect(isExternalRefConflict({ code: '23505', constraint: 'tickets_organization_id_ticket_number_key' })).toBe(false);
    expect(isExternalRefConflict(new Error('boom'))).toBe(false);
    expect(isExternalRefConflict(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm --workspace apps/api run test -- test/integration-tickets.test.ts
```
Expected: FAIL — `serializeIntegrationTicket` / `isExternalRefConflict` are not exported.

- [ ] **Step 3: Implement serializer, conflict predicate and orchestration**

Append to `apps/api/src/modules/integration-tickets.ts` (and add `import { withSystemContext } from '../db/pool.js';`, `import * as tickets from './tickets.js';`, `import type { Principal } from '../types.js';` to the imports):

```ts
export interface IntegrationTicketResponse {
  ticketId: string;
  ticketKey: string;
  externalRef: string;
  /** Anchor's authoritative status — not whatever the caller sent. */
  status: string;
  /** Anchor's current assignment, or null. Never derived from the caller's `owner`. */
  assignee: string | null;
  /** The CALLER's deadline (external_due_at), deliberately not Anchor's SLA resolution_due_at:
   *  returning the SLA clock under a field the caller reads as "my deadline" would mislead. */
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when this call minted the ticket (HTTP 201); false when it matched and updated (200). */
  created: boolean;
  /** Fields accepted syntactically but not applied — see NOT_APPLIED. */
  ignored: string[];
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string | Date).toISOString() : null;
}

/** Project a ticket row onto the integration contract. Keeping this a pure function means the
 *  external shape is pinned by unit tests and the internal column layout stays free to change. */
export function serializeIntegrationTicket(
  row: Record<string, unknown>,
  created: boolean,
  ignored: string[],
  assignee: string | null,
): IntegrationTicketResponse {
  return {
    ticketId: String(row.id),
    ticketKey: String(row.ticket_number),
    externalRef: String(row.external_ref),
    status: String(row.status),
    assignee,
    dueDate: iso(row.external_due_at),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    created,
    ignored,
  };
}

/**
 * Did this error come from losing a race on the external_ref unique index?
 *
 * `createTicket` does SELECT-then-INSERT, so two simultaneous first-syncs of the same item can
 * both miss the SELECT and one loses to ux_tickets_org_external_ref. For an endpoint whose
 * entire purpose is a safe retry, surfacing that as a 500 would be the wrong answer: the
 * loser's retry finds the row and takes the update path, which is the correct idempotent
 * outcome.
 */
export function isExternalRefConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null | undefined;
  return e?.code === '23505' && e?.constraint === 'ux_tickets_org_external_ref';
}

async function assigneeEmail(agentId: unknown): Promise<string | null> {
  if (!agentId) return null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query('SELECT email FROM users WHERE id=$1', [agentId]);
    return (rows[0]?.email as string | undefined) ?? null;
  });
}

/** Parse -> persist -> serialize. The only function the route calls. */
export async function upsertIntegrationTicket(
  actor: Principal,
  raw: unknown,
): Promise<{ created: boolean; body: IntegrationTicketResponse }> {
  const { input, ignored } = parseIntegrationTicket(raw);

  let result;
  try {
    result = await tickets.createTicket(actor, input);
  } catch (err) {
    if (!isExternalRefConflict(err)) throw err;
    // The row exists now; this attempt takes the update path.
    result = await tickets.createTicket(actor, input);
  }

  const { matched, ...row } = result;
  const created = !matched;
  const assignee = await assigneeEmail(row.assigned_agent_id);
  return { created, body: serializeIntegrationTicket(row, created, ignored, assignee) };
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/http/routes-extra.ts`, add to the imports:

```ts
import * as integrationTickets from '../modules/integration-tickets.js';
```

and add this route immediately after the `/api/v1/integration/api-keys` block:

```ts
  // ---------------- Integration: external GRC ticket upsert (ADR-0016) ----------------
  // The strict-parsed sibling of POST /api/v1/tickets: an unrecognised field is a 422, never a
  // silent drop. Request and response shapes live in modules/integration-tickets.ts, which is
  // the contract. 201 = created, 200 = matched an existing externalRef and updated it.
  app.post('/api/v1/integration/tickets', async (req, reply) => {
    const p = await requirePrincipal(req);
    const { created, body } = await integrationTickets.upsertIntegrationTicket(p, req.body);
    reply.status(created ? 201 : 200);
    return body;
  });
```

Auth needs no new code: the per-organization API key already carries `ticket.create` in `DEFAULT_KEY_SCOPES`, and `createTicket` calls `authorize(actor, 'ticket.create', { organizationId })`, so the PDP rejects an out-of-scope organization with 403.

- [ ] **Step 5: Write the failing end-to-end tests**

Append to `apps/api/test/integration/integration-tickets.int.test.ts` (add `import { upsertIntegrationTicket } from '../../src/modules/integration-tickets.js';` and `import { buildKeyPrincipal } from '../../src/auth/api-key.js';` at the top):

```ts
describeDb('upsertIntegrationTicket end to end', () => {
  let agent: Principal;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    agent = await principalByEmail('manager@nexus.example.com');
    const orgs = await withSystemContext(async (sql) =>
      (await sql.query('SELECT id, name FROM organizations ORDER BY name')).rows,
    );
    orgId = orgs.find((o: { name: string }) => o.name === 'Demo Corp').id;
    otherOrgId = orgs.find((o: { name: string }) => o.name !== 'Demo Corp').id;
  });

  function body(over: Record<string, unknown> = {}) {
    return {
      externalRef: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      organizationId: orgId,
      source: 'poam',
      title: 'Patch CVE-2026-1234',
      severity: 'high',
      status: 'open',
      priority: 'P1',
      tenantId: null,
      ...over,
    };
  }

  it('creates with created=true and the integration response shape', async () => {
    const { created, body: res } = await upsertIntegrationTicket(agent, body());
    expect(created).toBe(true);
    expect(res.created).toBe(true);
    expect(res.ticketKey).toMatch(/-\d{6}$/);
    expect(res.status).toBe('triage');
    expect(res.assignee).toBeNull();
    expect(res.ignored.sort()).toEqual(['priority', 'status', 'tenantId']);
    expect(res).not.toHaveProperty('ticket_number');
  });

  it('upserts the second time with created=false and the same identity', async () => {
    const payload = body();
    const first = await upsertIntegrationTicket(agent, payload);
    const second = await upsertIntegrationTicket(agent, { ...payload, title: 'Patch CVE-2026-1234 (rev 2)' });
    expect(second.created).toBe(false);
    expect(second.body.ticketId).toBe(first.body.ticketId);
    expect(second.body.ticketKey).toBe(first.body.ticketKey);
  });

  it('derives P2 from severity high', async () => {
    const { body: res } = await upsertIntegrationTicket(agent, body({ severity: 'high' }));
    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT priority FROM tickets WHERE id=$1', [res.ticketId])).rows[0],
    );
    expect(row.priority).toBe('P2');
  });

  it('round-trips metadata semantically', async () => {
    const metadata = { carbonFindingId: 'f-1', nested: { kev: true, score: 9.8 }, list: [1, 2, 3] };
    const { body: res } = await upsertIntegrationTicket(agent, body({ metadata }));
    const row = await withSystemContext(async (sql) =>
      (await sql.query('SELECT custom_fields FROM tickets WHERE id=$1', [res.ticketId])).rows[0],
    );
    expect(row.custom_fields).toEqual(metadata);
  });

  it('rejects an organization outside the key principal scope with 403 (tenant boundary)', async () => {
    const keyPrincipal = buildKeyPrincipal({
      id: 'key-1', organization_id: orgId, key_id: 'k1', key_hash: 'x', name: 'test key',
      scopes: ['ticket.create', 'ticket.read.organization'], expires_at: null, revoked_at: null,
    });
    await expect(
      upsertIntegrationTicket(keyPrincipal, body({ organizationId: otherOrgId })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('surfaces a sensitive metadata key as 422, not 500 (Review Focus 5)', async () => {
    await expect(
      upsertIntegrationTicket(agent, body({ metadata: { personal_email: 'leak@personal.example' } })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('resolves two concurrent first-syncs of one externalRef to a single ticket (Review Focus 4)', async () => {
    const payload = body();
    const [a, b] = await Promise.all([
      upsertIntegrationTicket(agent, payload),
      upsertIntegrationTicket(agent, payload),
    ]);
    expect(a.body.ticketId).toBe(b.body.ticketId);
    const count = await withSystemContext(async (sql) =>
      (await sql.query('SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1 AND external_ref=$2',
        [orgId, payload.externalRef])).rows[0].n,
    );
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 6: Run them and make sure they pass**

```bash
cd /Users/kevinwhite/Developer/NexusCyber_Support
set -a; . ./.env; set +a
npm --workspace apps/api run test -- test/integration-tickets.test.ts test/integration/integration-tickets.int.test.ts
```
Expected: all passed, **0 skipped**. If the concurrency test is flaky, that is a real finding about `createTicket`'s SELECT-then-INSERT — report it rather than deleting the test.

- [ ] **Step 7: Typecheck and run the full suite**

```bash
npm --workspace apps/api run typecheck
set -a; . ./.env; set +a
npm --workspace apps/api run test
```
Expected: typecheck clean; whole suite green with no new skips.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/integration-tickets.ts apps/api/src/http/routes-extra.ts apps/api/test/integration-tickets.test.ts apps/api/test/integration/integration-tickets.int.test.ts
git commit -m "feat(api): POST /api/v1/integration/tickets

Strict-parsed upsert for the external GRC integration. Response is an
integration-shaped projection rather than the ticket row, so the column
layout stays free to change. A lost race on the external_ref unique index
retries into the update path instead of surfacing a 500.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/nexus/anchor-integration-external-contract.md`
- Modify: `docs/nexus/carbon-conmon-integration-response.md`
- Modify: `docs/knowledge/architecture-decisions/ADR-0016-strict-integration-ticket-endpoint.md`
- Modify: `docs/knowledge/architecture-decisions/README.md`

- [ ] **Step 1: Add the endpoint to the external contract**

In `docs/nexus/anchor-integration-external-contract.md`, insert this immediately after the
"Outbound — create/update a ticket" section:

```markdown
## Outbound — strict upsert (preferred)

`POST /api/v1/integration/tickets` — same per-organization API key. **Prefer this over
`POST /api/v1/tickets`:** it takes the integration vocabulary directly and an unrecognised
field is a `422` rather than a silent drop.

`externalRef` is **required** (the endpoint is upsert-only) and is NOT validated as a uuid — a
programme-scoped key such as `carbon-conmon:backlog:WS-1.1` is accepted as-is.

### Applied

| field | type | notes |
|---|---|---|
| externalRef | string **req** | 1–200, the idempotency key |
| organizationId | uuid **req** | must match the key's org, else 403 |
| source | string **req** | ≤60 → `external_source` |
| title | string **req** | 3–300 → `subject` |
| description | string? | ≤20000 |
| severity | `critical`\|`high`\|`medium`\|`low`\|null? | **also drives priority**: critical→P1, high→P2, medium→P3, low→P4, null→P3 |
| sourceId | string? | → `external_source_id`; survives a change to the externalRef format |
| owner | string? | → `external_owner`, **text only — never sets the assignee** |
| controlIds | string[]? | → `control_ids` (queryable) |
| dueDate | ISO 8601? | → `external_due_at`, the CALLER's deadline, distinct from Anchor's SLA clock |
| labels | string[]? | → `tags` |
| carbonUrl | url? | → `external_url` |
| metadata | object? | → `custom_fields` |

On an upsert, **key presence matters**: an omitted key preserves the stored value, an explicit
`null` clears it. So `"dueDate": null` withdraws a deadline; omitting `dueDate` keeps it.

### Accepted but not applied

`status`, `priority` and `tenantId` are accepted and returned in the response's `ignored[]`
array. Anchor owns the lifecycle (status moves only via `/transition`), derives priority from
impact × urgency (there is no `P0`), and has no tenant concept. They are reported rather than
refused so a conformant payload keeps working — check `ignored[]` if you expect them to apply.

### Refused — 422

`parentExternalRef`, `estimateDays`, `phase`, `workstream`, `acceptanceCriteria` and
`blockedReason` (phase D, not yet supported), and **any unrecognised field**. The response is an
RFC 7807 problem document whose `errors[]` names each offending field.

### Response

```json
{ "ticketId":"...", "ticketKey":"DEMO-000123", "externalRef":"...", "status":"triage",
  "assignee":null, "dueDate":"2026-11-30T00:00:00.000Z",
  "createdAt":"...", "updatedAt":"...", "created":true, "ignored":["status","priority"] }
```

**HTTP 201 = created, 200 = matched an existing externalRef and updated it**, mirrored by
`created`. `status` and `assignee` are Anchor's authoritative values, not what was sent.
`dueDate` echoes `external_due_at` — your deadline, not Anchor's SLA `resolution_due_at`.

### Two things to know about metadata

- It round-trips **semantically, not byte-identically** — it is stored as `jsonb`, which
  normalises key order and whitespace. Hash a canonical form, or keep the hash on your side.
- A key an administrator has flagged `sensitive` on any request form is **refused with a 422**,
  not stripped. Namespace your keys to stay clear of the PII vault boundary.
```

- [ ] **Step 2: Mark A′ shipped in the Carbon response**

In `docs/nexus/carbon-conmon-integration-response.md` §7, change the **A′** row's status cell from `gates S1.7; Carbon can ship against the existing contract meanwhile` to a shipped note naming the new route. Leave phases B, C and D as they are.

- [ ] **Step 3: Accept the ADR**

In `ADR-0016`, change **Status** from `Proposed` to `Accepted`. In `docs/knowledge/architecture-decisions/README.md`, change the 0016 row's status column from `Proposed` to `Accepted`.

- [ ] **Step 4: Verify the docs claim nothing false**

Re-read the new contract section against the implemented module. Specifically confirm: the field list matches `payloadSchema` exactly, the `ignored[]` list matches `NOT_APPLIED`, and the refused list matches `DEFERRED`. A contract doc that drifts from the schema is worse than no doc.

- [ ] **Step 5: Commit**

```bash
git add docs/nexus/anchor-integration-external-contract.md docs/nexus/carbon-conmon-integration-response.md docs/knowledge/architecture-decisions/ADR-0016-strict-integration-ticket-endpoint.md docs/knowledge/architecture-decisions/README.md
git commit -m "docs(integration): document the strict integration ticket endpoint

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

```bash
cd /Users/kevinwhite/Developer/NexusCyber_Support
set -a; . ./.env; set +a
npm --workspace apps/api run typecheck
npm --workspace apps/api run test
git log --oneline main..HEAD
```

Confirm, by reading the output rather than assuming it:
- typecheck exits clean
- the suite reports **passed with 0 skipped** for both `integration-tickets` files — a skip here means `DATABASE_URL` was not loaded and nothing was actually verified
- six commits on the branch

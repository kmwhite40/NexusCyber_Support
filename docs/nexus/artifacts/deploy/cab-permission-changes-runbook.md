# Runbook: deploying the CAB separation-of-duties + template reclassification migrations

Covers migrations
[`0061_cab_separation_of_duties.sql`](../../../../apps/api/src/db/migrations/0061_cab_separation_of_duties.sql)
and
[`0062_cab_template_reclassification.sql`](../../../../apps/api/src/db/migrations/0062_cab_template_reclassification.sql).

**There is no feature flag on this.** Migrations apply automatically on the next `anchor-api`
boot (this environment runs with `RUN_MIGRATIONS_ON_BOOT=true`, per the API's `migrate()` in
`apps/api/src/db/migrate.ts`), and `scripts/deploy-api.sh` restarts the container as its last
step — so **running that script deploys these permission and data changes**, live, the moment
the new image comes up. Read this whole document before you run it.

## 1. What actually changes

### 0061 — separation of duties

- Any role that holds **both** `change.create` and `cab.manage` loses `change.create`, **unless**
  that role also holds `admin.superuser` (break-glass roles are outside the SoD model by design
  and are left alone). In the seeded role set, this is **`ServiceDeskManager`**.
- `ServiceDeskManager` keeps `change.approve`, `change.vote`, `change.implement`, and commenting
  — per `apps/api/src/modules/changes.ts`, submitting to CAB (`submitForCab`) already accepts
  either `change.create` **or** `cab.manage`, and withdraw/cancel accepts `change.implement` as
  an alternative to `change.create`. What a `ServiceDeskManager` can no longer do is **originate**
  a new change (`POST /changes`, gated on `change.create` alone) or build one from a raiser-facing
  template picker.
- Raising a change moves to whoever holds `change.create` without `cab.manage` — in the seeded
  roles, that's **Tier2** and **SecurityAnalyst**.
- Adds `changes.standard_template_id` (nullable FK to `change_templates`, `ON DELETE SET NULL`).
  A `standard` change now must be backed by a template row authored under `cab.manage`; a
  `standard` change with no template is refused at CAB submission (see `apps/api/src/modules/cab.ts`).
- Flips `change_templates.change_type`'s column default from `'standard'` to `'normal'` for future
  inserts. It does **not**, by itself, touch any existing row — that's what 0062 does.

### 0062 — template + draft reclassification

- **Every** existing `change_templates` row with `change_type = 'standard'` is rewritten to
  `'normal'`. This is blanket, not scoped to "created before 0061" — 0061 and 0062 apply in the
  same run on any database that hasn't seen either, so the predicate is equivalent and simpler.
  Practical effect: **every standing pre-approval goes dark** the instant this migration commits.
  A raiser who used to pick a template and skip the CAB now goes through CAB voting for that same
  work, until someone with `cab.manage` deliberately re-declares the template as `standard` again.
- Any `changes` row still in **`draft`** with `change_type = 'standard'` is rewritten to `'normal'`.
  These predate `standard_template_id` and carry no provenance, so `submitForCab` would otherwise
  403 them with no way forward but delete-and-recreate. This migration routes them through CAB
  instead, as if self-classification had never existed.
- Changes already **approved / scheduled / implementing / review / closed** and marked `standard`
  are **left untouched** — they're a historical record of a decision already made under the old
  rules; rewriting the type would falsify the audit trail without changing the outcome.

### Who is affected, concretely

The people who **lose the ability to raise a change** are exactly the people who **gain the
re-declaration workload** for templates: `ServiceDeskManager` holds both `change.create` and
`cab.manage` today, so the same humans who can no longer click "New Change" are the only ones
who can turn a lost pre-approval back on. Plan the announcement around that — it is not two
separate audiences.

## 2. Pre-deploy: capture read-only baselines

Run these against the **live** database before deploying. Two of them (the standard-template
list and the standard-draft list) capture information that 0062 destroys — the `change_type`
overwrite is not itself logged anywhere, so this is the **only** record of what used to be a
pre-approval unless you capture it first. Save the output (copy the terminal, or use `psql -c
"\copy (...) to 'file.csv' csv header"` locally).

Connect however you normally reach the target DB (see `dev-db-port-and-migrate` memory for the
local dev pattern; in the Azure Gov environment, use the same DB connection the migrator uses).

```sql
-- 2a. Roles that will lose change.create (and to whom it's attached today).
--     Expect ServiceDeskManager here. Anything else appearing is worth a second look
--     before you deploy, not after.
SELECT r.key AS role_key
FROM roles r
WHERE EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = 'change.create')
  AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = 'cab.manage')
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = 'admin.superuser');

-- 2b. Named users who will lose change.create via one of those roles — this is your
--     announcement recipient list. (A user in more than one qualifying role appears once
--     per role; dedupe on email if you want a flat notify list.)
SELECT DISTINCT u.email, u.display_name, r.key AS role_key, ra.organization_id
FROM role_assignments ra
JOIN roles r ON r.id = ra.role_id
JOIN users u ON u.id = ra.user_id
WHERE r.key IN (
  SELECT r2.key FROM roles r2
  WHERE EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r2.id AND rp.permission_key = 'change.create')
    AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r2.id AND rp.permission_key = 'cab.manage')
    AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r2.id AND rp.permission_key = 'admin.superuser')
)
ORDER BY u.email;

-- 2c. Template counts by type — the "before" snapshot to diff against after deploy.
SELECT change_type, count(*) AS n
FROM change_templates
GROUP BY change_type
ORDER BY change_type;

-- 2d. THE RE-DECLARATION LIST. Full detail on every template that is about to lose its
--     'standard' classification. This is the checklist to hand to cab.manage holders —
--     capture it now; 0062 overwrites change_type in place with no history table.
SELECT id, organization_id, name, risk, impact, likelihood, description
FROM change_templates
WHERE change_type = 'standard'
ORDER BY organization_id NULLS FIRST, name;

-- 2e. Standard changes still in draft — these get force-routed to CAB by 0062.
--     Capture ticket_id/created_by so you can tell the owner their change now needs a vote.
SELECT id, ticket_id, organization_id, title, status, change_type, created_by
FROM changes
WHERE change_type = 'standard' AND status = 'draft'
ORDER BY organization_id NULLS FIRST, created_at;

SELECT count(*) AS standard_drafts_before FROM changes WHERE change_type = 'standard' AND status = 'draft';

-- 2f. Sanity: how many approved/scheduled/etc. 'standard' changes exist, that 0062 will
--     deliberately leave alone (so you're not surprised when they don't change).
SELECT status, count(*) AS n
FROM changes
WHERE change_type = 'standard'
GROUP BY status
ORDER BY status;
```

## 3. Announcement sequence

Do this **before** you deploy — permission and data changes with no flag mean there is no
"soft launch," so the announcement has to land before the behavior does, not after.

1. **To everyone in the 2b recipient list (ServiceDeskManager holders):** "As of `<date/time>`,
   raising a new change (the `change.create` action) moves off this role. You keep approving,
   voting, implementing, and commenting on changes, and you keep managing the CAB board. To
   originate a new change after the deploy, ask a Tier2 or SecurityAnalyst holder to raise it —
   or route the request through the normal ticket flow if one exists. This is a permission split
   (separation of duties: whoever administers the board that judges a change shouldn't also be
   able to raise it), not a demotion."
2. **To the same list, same message, second half:** "Every standing change-template
   pre-approval in the system is being reset to 'normal' at the same time — including any you
   authored. If a template you rely on is a genuine, deliberate pre-approval (recurring low-risk
   work that shouldn't need a CAB vote every time), you'll need to re-declare it as `standard`
   yourself after the deploy — you still hold `cab.manage`, so you can do this in place. Attached
   is the exact list of what's being reset (§2d output) so you know what to look at." Attach the
   2d query output.
3. **To anyone named in the 2e list (owners of standard-status draft changes):** "Your draft
   change `<title>` (ticket `<ticket_id>`) will move from pre-approved to requiring a CAB vote
   as part of this deploy, because it predates template-based provenance. No data is lost; it
   simply needs a board vote before it can proceed. Nothing else about your approved/scheduled
   changes is affected."
4. **To whoever chairs/administers the CAB board(s):** "Expect a wave of re-declaration requests
   and possibly a short-term increase in vote volume from templates going dark and drafts
   routing through CAB. This is expected and temporary."
5. **Timing:** send 1–3 ahead of the deploy window with enough lead time that recipients can
   finish anything time-sensitive (e.g., raise a change they were about to raise) before the
   permission actually changes. There's no way to schedule the cutover for a specific instant
   short of choosing when you run `scripts/deploy-api.sh` — say so plainly rather than promising
   a maintenance window the migration mechanism doesn't actually support.

## 4. Deploy

This environment applies pending migrations automatically on API boot
(`RUN_MIGRATIONS_ON_BOOT=true`), so the deploy step **is** the migration step:

```bash
scripts/deploy-api.sh
```

What this does, relevant to this change (see the script and the `azure-gov-deployment` memory
for the full mechanics): builds a new image in ACR, pins the App Service to the resulting
digest, restarts the container, and polls `/readyz`. On restart, `server.ts` runs `migrate()`
before it starts listening, which applies `0061` then `0062` (lexicographic order, each in its
own transaction, tracked in `schema_migrations`) — so by the time `/readyz` returns 200, both
migrations have already committed.

To watch the migration apply in real time instead of only trusting `/readyz`, tail the container
logs during the restart:

```bash
az webapp log tail -g anchor-gov-rg -n anchor-api
```

Look for `apply 0061_cab_separation_of_duties.sql`, `apply 0062_cab_template_reclassification.sql`,
and `migrations complete` in that order. If either migration errors, `migrate.ts` rolls back that
migration's own transaction and the process exits non-zero — `/readyz` will not go green, and
`scripts/deploy-api.sh` will report the app never became ready. That is the failure signal to
watch for; see §6 if it happens.

## 5. Post-deploy verification

Re-run the queries from §2 and diff against your captured baseline:

```sql
-- 5a. Confirm the SoD grant is gone. Should return ZERO rows (any role here still
--     holding both change.create and cab.manage without admin.superuser is a bug).
SELECT r.key AS role_key
FROM roles r
WHERE EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = 'change.create')
  AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = 'cab.manage')
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = 'admin.superuser');

-- 5b. Template counts by type — 'standard' count should now be ZERO (or exactly the
--     count of templates deliberately re-declared since deploy, if you check this later).
SELECT change_type, count(*) AS n FROM change_templates GROUP BY change_type ORDER BY change_type;

-- 5c. No standard drafts remain.
SELECT count(*) AS standard_drafts_after FROM changes WHERE change_type = 'standard' AND status = 'draft';
-- expect 0

-- 5d. The drafts captured in §2e are now 'normal' and still open (not silently closed).
SELECT id, ticket_id, title, status, change_type
FROM changes
WHERE id IN (/* paste the ids you captured in 2e */)
ORDER BY id;
-- expect status still 'draft', change_type now 'normal'

-- 5e. Already-decided 'standard' changes are untouched — compare counts to §2f.
SELECT status, count(*) AS n FROM changes WHERE change_type = 'standard' GROUP BY status ORDER BY status;

-- 5f. Schema check: the new column exists and the app can write to it.
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = 'changes' AND column_name = 'standard_template_id';
```

Functional check in the UI/API (not just SQL): as a `ServiceDeskManager` user, confirm
`POST /changes` now 403s with "missing change.create" (or the app's equivalent forbidden
response) while the change list, approve, vote, implement, and comment actions still work. As a
`cab.manage` holder, confirm you can create a new `change_templates` row with `change_type =
'standard'` (re-declaring one from the §2d list) and that a raiser can subsequently build a
change from it that skips CAB voting.

## 6. Rollback — read this before you assume there is a clean one

**There is no clean revert.** The migration runner in `apps/api/src/db/migrate.ts` is explicitly
forward-only: it tracks applied filenames in `schema_migrations` and has no `down` migration
concept. "Rolling back" 0061/0062 means writing and applying a **new**, later-numbered migration
that reverses the specific effects — it is not a `git revert` + redeploy, and even the new
migration cannot undo everything cleanly:

- **The permission grant can be restored exactly.** A compensating migration can
  `INSERT INTO role_permissions (role_id, permission_key) SELECT id, 'change.create' FROM roles
  WHERE key = 'ServiceDeskManager' ON CONFLICT DO NOTHING;` — this is fully reversible because
  the grant itself is just a row.
- **The template reclassification is NOT cleanly reversible.** 0062 overwrote
  `change_templates.change_type` in place with no history table recording which rows were
  `standard` before. The **only** record of the pre-image is whatever you captured in §2d before
  deploying. A compensating migration can restore exactly those rows to `standard` **only if**
  you saved that list — e.g. `UPDATE change_templates SET change_type = 'standard' WHERE id IN
  (<ids from your §2d capture>);`. If you didn't capture it, the honest answer is that the set of
  templates that used to be pre-approved is **gone**, and reconstructing it means asking every
  `cab.manage` holder which of their templates used to be standard and re-declaring by hand —
  which is functionally identical to the deliberate re-declaration workflow this migration
  intended to force in the first place.
- **The draft reclassification is reversible the same conditional way** — restore
  `change_type = 'standard'` on exactly the change ids captured in §2e, using your saved list, not
  a blanket predicate (a blanket `UPDATE changes SET change_type='standard' WHERE status='draft'`
  would incorrectly reclassify drafts that were legitimately created as `'normal'` after the
  deploy).
- **Column removal is optional and one-directional in a different way**: dropping
  `changes.standard_template_id` destroys the provenance links written by every `standard` change
  created after 0061 shipped. Don't drop it as part of a rollback unless you are also reverting
  every change raised in the interim — in practice, leave the column in place even if you revert
  the behavior around it.

Given the above, treat "rollback" as **damage control, not undo**: restore the permission grant
immediately if it's causing an operational problem (that part is genuinely safe and instant), and
treat template/draft reclassification as a data-recovery exercise that depends entirely on
whether §2's baseline capture happened — which is why §2 is not optional.

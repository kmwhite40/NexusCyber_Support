# ES-04 — Database & Migration Standards

| | |
|---|---|
| **Applies to** | `apps/api/src/db/**`, Azure PostgreSQL Flexible Server `anchor-pg` |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Platform

- **PostgreSQL 16** (CI) / Azure Database for PostgreSQL Flexible Server (production, `usgovtexas`).
- Required extensions: `pgcrypto`, `citext`. On Azure these must be allow-listed through the server parameter `azure.extensions` **before** migrations run.

## 2. Two database roles — use the right one

| Role | Env var | Used for | RLS |
|---|---|---|---|
| Owner | `DATABASE_URL` | migrations, seed, system context, ops scripts | **bypassed** |
| `nexus_app` | `APP_DATABASE_URL` | every tenant-scoped request | **enforced** |

- Request handlers run as `nexus_app`, inside a transaction that sets `app.plane`, `app.org_id`, `app.assigned_orgs` and `app.elevated` with `set_config(..., true)` (transaction-local, never leaks across pooled connections).
- Use `withSystemContext` only for genuinely global work (migrations, global config, auth lookups before an org is known). Every use needs a comment saying why.
- Ad-hoc production queries must use the **owner** URL. Using `APP_DATABASE_URL` without context returns **empty results silently** because of RLS — it looks like missing data, not an error.

## 3. Migrations

- Location: `apps/api/src/db/migrations/NNNN_snake_case_description.sql` (four-digit, zero-padded, next free number).
- **Forward-only.** No down migrations. To undo, write a new migration.
- Each file runs in **one transaction** and is recorded in `schema_migrations`. A failure rolls back that file and stops the runner.
- **Never edit a migration that has been applied anywhere.** Fix forward.
- Migrations must be **idempotent where practical** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, guarded `UPDATE`s) so a re-run on a partially-seeded environment is harmless.
- Use **expand → migrate → contract** for breaking schema changes: add the new column, ship code that writes both, backfill, then drop the old one in a later release.
- Every new tenant table **must**: carry `organization_id`, `ENABLE ROW LEVEL SECURITY`, and have policies keyed on `current_setting('app.org_id')`. Add a cross-org integration test (ES-03).
- Do not hard-code credentials in migrations. (Migration 0001's `nexus_app` password is a known legacy exception; production overrides it with `ALTER ROLE` during deploy.)
- Production applies migrations on boot when `RUN_MIGRATIONS_ON_BOOT=true`. A migration that cannot apply **aborts startup** — test it against a copy of production-shaped data first.

## 4. Seed data and content dual-write

`seed.ts` only affects **fresh installs**. Production already has its rows. So any change to seeded content — KB articles, catalog items, catalog→form links, templates — must be made in **both** places:

1. `seed.ts` (so new environments are correct), and
2. a new idempotent migration (so existing environments are corrected).

KB cross-references use `/kb?q=` deep links, not hard-coded IDs.

## 5. Concurrency

- Allocate sequential business identifiers (ticket numbers) under a lock or a single atomic statement. The ticket-number race (fixed in `708b7ff`) happened because three create paths allocated numbers without serialization.
- Commit dedupe markers in the **same transaction** as the record they protect.

## 6. Backups and access

- `scripts/db-backup.sh` / `scripts/db-restore.sh` for logical backups. Dumps never go into git.
- `anchor-pg` accepts Azure services only. Operator access requires a temporary `/32` firewall rule that is **removed when you finish**.

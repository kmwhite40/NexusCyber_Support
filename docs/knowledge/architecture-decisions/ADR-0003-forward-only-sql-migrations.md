# ADR-0003 — Forward-only SQL migrations, applied on boot, with seed dual-write

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 (dual-write rule added 2026-09) |
| **Related** | ES-04; migration 0067 |

## Context
Schema changes must apply identically in dev, CI and production; production is reached only from inside Azure. Seeded content (KB, catalog, forms) is also edited over time.

## Decision
- Plain `.sql` files, `NNNN_description.sql`, applied in lexicographic order by a ~50-line runner (`db/migrate.ts`). Each file runs in its own transaction and is recorded in `schema_migrations`.
- **Forward-only**; never edit an applied migration.
- Production applies pending migrations at boot (`RUN_MIGRATIONS_ON_BOOT=true`), inside the network boundary.
- Seeded content changes are written to **both** `seed.ts` and a new idempotent migration.

## Alternatives considered
| Option | Why not |
|---|---|
| Migration framework with down scripts | Down scripts are rarely tested; forward fixes are safer. |
| Manual migration from an operator host | Needs a firewall hole into `anchor-pg` each time. |
| Seed-only content | Seed never re-runs in production, so edits silently never ship (the catalog→form link bug). |

## Consequences
**Positive:** simple, auditable, reproducible; 80+ migrations applied without a framework.
**Negative:** a bad migration blocks API startup; deploy verification must confirm the new build booted (ADR-0008).

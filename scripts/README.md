# Operational scripts

Runbook helpers ([docs/nexus/10-stack-ux-ops.md §X](../docs/nexus/10-stack-ux-ops.md)).
Dependency-light (bash + curl + node + the Postgres Docker container).

| Script | Purpose |
|--------|---------|
| `smoke.sh` | Post-deploy smoke: health/readiness + auth + core read endpoints return 200. Exits non-zero on first failure — wire into a deploy gate. |
| `db-backup.sh` | Timestamped custom-format `pg_dump` into `./backups/` (CP control family / backup-restore testing). |
| `db-restore.sh` | Restore a dump into the target DB (DR drill). **Destructive** — prompts before overwriting. |

```bash
chmod +x scripts/*.sh   # once

# smoke against the local stack
BASE_URL=http://localhost:4000/api/v1 scripts/smoke.sh

# backup -> restore drill
scripts/db-backup.sh
scripts/db-restore.sh backups/anchor-nexus-<stamp>.dump
scripts/smoke.sh        # verify the restore
```

### Environment overrides

| Var | Default | Used by |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:4000/api/v1` | smoke |
| `DEMO_EMAIL` | `agent@nexus.example.com` | smoke (dev-login identity) |
| `DB_CONTAINER` | `nexus-db` | backup/restore (unset to use `DATABASE_URL` + host `pg_*`) |
| `DB_NAME` / `DB_USER` | `nexus` / `nexus` | backup/restore |

> Backups are written to `./backups/` (git-ignored). Encrypt + ship to immutable,
> geo-redundant storage within the data boundary for real deployments
> ([docs/nexus/08 §Q.6](../docs/nexus/08-ai-security-compliance.md)).

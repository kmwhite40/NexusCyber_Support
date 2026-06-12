# Operational scripts

Runbook helpers ([docs/nexus/10-stack-ux-ops.md §X](../docs/nexus/10-stack-ux-ops.md)).
Dependency-light (bash + curl + node + the Postgres Docker container).

| Script | Purpose |
|--------|---------|
| `deploy-web.sh` | Build + deploy `apps/web` (Next.js standalone) to the Azure Gov App Service. Bakes the prod `NEXT_PUBLIC_API_BASE`, asserts no `localhost` leaks, ships the flattened standalone bundle (`node server.js`), and verifies the site returns 200. Requires `az` logged into AzureUSGovernment. |
| `smoke.sh` | Post-deploy smoke: health/readiness + auth + core read endpoints return 200. Exits non-zero on first failure — wire into a deploy gate. |
| `db-backup.sh` | Timestamped custom-format `pg_dump` into `./backups/` (CP control family / backup-restore testing). |
| `db-restore.sh` | Restore a dump into the target DB (DR drill). **Destructive** — prompts before overwriting. |

```bash
chmod +x scripts/*.sh   # once

# deploy the web app to Azure Gov (az must be logged into AzureUSGovernment)
scripts/deploy-web.sh
#   overrides: RG=M365_Compliance APP=Anchor API_BASE=https://anchor-api.azurewebsites.us/api/v1

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

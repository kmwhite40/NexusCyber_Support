# ES-07 — Deployment & Release Standards

| | |
|---|---|
| **Applies to** | Azure Government production (`anchor` web, `anchor-api`) |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

## 1. Production topology

| Component | Resource | Region |
|---|---|---|
| Web (Next.js standalone, Node 22) | App Service `Anchor` → `anchor.azurewebsites.us` | usgovvirginia |
| API (container) | App Service `anchor-api` → `anchor-api.azurewebsites.us` | usgovtexas |
| Database | PostgreSQL Flexible `anchor-pg` | usgovtexas |
| Images | ACR (Basic) | usgovtexas |

Infrastructure is defined in Bicep under `infra/azure/`. Portal changes must be reflected back into Bicep.

## 2. How to deploy

Always use the scripts — they encode lessons from failed deploys.

```bash
az cloud set --name AzureUSGovernment && az login
scripts/deploy-api.sh
scripts/deploy-web.sh
scripts/smoke.sh
```

**API (`deploy-api.sh`)** builds in ACR (no local Docker), tags with the git short SHA, **pins the App Service to the image digest** (restarting a `:latest` tag does not pull a new image), restarts, then waits until `/healthz` reports **this build's SHA** — not merely any 200 from the old container.

**Web (`deploy-web.sh`)** builds a flattened Next.js standalone bundle locally and OneDeploys it. `NEXT_PUBLIC_API_BASE` is baked in at build time, so changing the API URL means rebuilding the web app.

## 3. Rules

- Deploy only from a clean `main` that has passed CI.
- Never run `next build` while `next dev` is running locally — they share `apps/web/.next` and corrupt each other.
- The API startup command is a single command (`node dist/server.js`). Do not use `sh -c "a && b"` forms; App Service mis-tokenizes them.
- Migrations run on boot (`RUN_MIGRATIONS_ON_BOOT=true`); a failing migration fails the deploy. Review migrations as carefully as code.
- Enabling a feature flag in production is a **change** — record it (date, who, why) the same way as a code deploy.
- After every deploy: run `scripts/smoke.sh` and check the API logs for a clean boot.

## 4. Change records

Material production changes (new integration enabled, new Graph permission consented, schema change on large tables) go through the CAB workflow in Anchor itself.

## 5. Rollback

- **API:** re-pin the previous image digest and restart.
- **Web:** redeploy the previous commit's bundle.
- **Schema:** migrations are forward-only — roll forward with a corrective migration; restore from backup only for data loss.

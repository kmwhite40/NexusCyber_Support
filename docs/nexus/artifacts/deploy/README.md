# Deployment artifacts

Implements the **containerized portable architecture** option ([10-stack-ux-ops.md §V.5](../../10-stack-ux-ops.md)).
One codebase deploys to commercial and (separately) government enclaves; the only
differences are configuration (`cloud_environments`, feature flags) and the data
boundary — never code.

## Images

| Image | Dockerfile | Notes |
|-------|------------|-------|
| `nexus-api` | [apps/api/Dockerfile](../../../../apps/api/Dockerfile) | Multi-stage; compiled `dist/` + bundled `.sql` migrations; non-root; `/healthz` + `/readyz` |
| `nexus-web` | [apps/web/Dockerfile](../../../../apps/web/Dockerfile) | Next.js **standalone** output; `NEXT_PUBLIC_API_BASE` baked at build time |

```bash
# build from the repo root
docker build -f apps/api/Dockerfile -t nexus-api .
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_BASE=https://api.example.com/api/v1 -t nexus-web .
```

## Local full stack (production-style)

```bash
docker compose -f docker-compose.prod.yml up --build
# db -> 5432, api -> :4000, web -> :3000
# the one-shot `migrate` service runs migrations + seed, then the api waits on it
```

## Azure (commercial)

A compact **Container Apps + Postgres Flexible Server** starting point is in
[`infra/azure/main.bicep`](../../../../infra/azure/main.bicep):

```bash
az group create -n nexus-rg -l eastus
az deployment group create -g nexus-rg -f infra/azure/main.bicep \
  -p apiImage=<acr>/nexus-api:latest webImage=<acr>/nexus-web:latest \
     pgAdminPassword=<secret> sessionSigningKey=<secret>
```

Production hardening to layer on (per [§V.3](../../10-stack-ux-ops.md)): Front Door + WAF,
Private Endpoints for Postgres/Key Vault, Managed Identity + Key Vault for secrets
(replace the env-var `SESSION_SIGNING_KEY` / DB passwords), Log Analytics + App
Insights, and CMK for high-sensitivity tenants.

## Azure Government enclave

Deploy the **same images** into a **separate** Azure Government subscription/resource
group with its own pipeline and data boundary. Differences are configuration only:

| Setting | Commercial | Government |
|---------|-----------|------------|
| `ENCLAVE` | `commercial` | `gov` |
| Identity authority / Graph endpoint | `*.microsoftonline.com` / `graph.microsoft.com` | `*.microsoftonline.us` / `graph.microsoft.us` (🔍 validate) |
| Region | Azure Commercial | Azure Government only |
| AI provider | Azure OpenAI (commercial) | gov-authorized model or **disabled** |
| Cross-enclave data flow | — | **none** (only non-sensitive aggregates, if approved) |

Verify every Azure service used is FedRAMP High / IL-authorized in the target gov
region before GA ([14-final-deliverables.md OQ-01](../../14-final-deliverables.md)).

## Environment variables

| Var | Used by | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | api (migrate/seed) | owner connection (bootstraps schema, bypasses RLS) |
| `APP_DATABASE_URL` | api (runtime) | non-owner role → **RLS enforced** on requests |
| `SESSION_SIGNING_KEY` | api | dev JWT signing; **replace with Key Vault / OIDC in prod** |
| `WEB_ORIGIN` | api | CORS allow-list |
| `ENCLAVE` | api | `commercial` \| `gov` (selects cloud behavior) |
| `NEXT_PUBLIC_API_BASE` | web (build-time) | browser-facing API URL |

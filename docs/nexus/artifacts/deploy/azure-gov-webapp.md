# Deploy & configure Anchor on Azure Government App Service (GCC / .us)

Step-by-step to stand up the **Anchor** API and Web as **Azure Web Apps for Containers**
in an **Azure US Government** subscription, and how to configure them. Aligns with the
government-enclave model in [10-stack-ux-ops.md §V.4](../../10-stack-ux-ops.md) and the
identity/integration caveats in [06-notifications-m365.md](../../06-notifications-m365.md).

> **Scope of this document.** It provides the IaC, scripts, and exact configuration to
> deploy. The actual deployment must run inside **your** Azure Government subscription
> with an authenticated `az` session — it cannot be performed from outside your tenant.

## 0. Why a separate Government deployment

Anchor is **one codebase, two enclaves**. The Government deployment uses the **same
container images** but a **separate** subscription, region, data boundary, and pipeline.
Differences are configuration only — never code.

| Concern | Commercial | **Government (.us)** |
|---------|-----------|----------------------|
| `az cloud` | `AzureCloud` | **`AzureUSGovernment`** |
| ARM endpoint | `management.azure.com` | `management.usgovcloudapi.net` |
| App Service hostname | `*.azurewebsites.net` | **`*.azurewebsites.us`** |
| Container registry | `*.azurecr.io` | **`*.azurecr.us`** |
| Key Vault | `*.vault.azure.net` | **`*.vault.usgovcloudapi.net`** |
| Entra authority / Graph | `login.microsoftonline.com` / `graph.microsoft.com` | **`login.microsoftonline.us` / `graph.microsoft.us`** (🔍 validate) |
| `ENCLAVE` app setting | `commercial` | **`gov`** |
| Image source | GHCR ok | **ACR in the gov subscription** (don't pull from commercial registries into gov) |

> **Registry:** build/push images to **Azure Container Registry in the gov subscription**
> (`*.azurecr.us`). Do not pull the GHCR images from `docker.io`/`ghcr.io` into a gov
> web app — keep the supply chain inside the boundary. `deploy-gov.sh` uses `az acr build`,
> which builds **in-region**, so no image ever leaves the boundary.

## 1. Prerequisites

- An **Azure Government** subscription with **Contributor** + **User Access Administrator**
  (the Bicep creates role assignments for managed identities).
- Azure CLI ≥ 2.55 (`az version`).
- Confirm each service is authorized in your target gov region (Postgres Flexible Server,
  App Service, ACR, Key Vault). For FedRAMP/IL scope, verify against your authorization
  boundary ([14-final-deliverables.md OQ-01](../../14-final-deliverables.md)).

## 2. One-command deploy

```bash
az cloud set --name AzureUSGovernment
az login                       # device-code / browser

export PG_ADMIN_PASSWORD='<strong-secret>'
export APP_DB_PASSWORD='<strong-secret>'      # runtime nexus_app role (RLS-enforced)
export SESSION_KEY="$(openssl rand -hex 48)"  # replace with OIDC in real prod
export RG=anchor-gov-rg
export LOCATION=usgovvirginia                 # or usgovtexas / usgovarizona

infra/azure/deploy-gov.sh
```

What it does (idempotent):
1. Targets `AzureUSGovernment` and your subscription.
2. Deploys [`webapp-gov.bicep`](../../../../infra/azure/webapp-gov.bicep): **ACR, Key Vault,
   Postgres Flexible Server, Log Analytics, a Linux App Service plan, and the `anchor-api`
   and `anchor-web` Web Apps** (system-assigned identities, `AcrPull` + `Key Vault Secrets
   User`, HTTPS-only, TLS 1.2, health checks).
3. Builds both images **in ACR** (`az acr build`) — `anchor-web` is built with
   `NEXT_PUBLIC_API_BASE=https://<api>.azurewebsites.us/api/v1`.
4. Runs **migrate + seed** as a one-off container against Postgres.
5. Restarts the web apps so they pull the freshly built images.
6. Prints the URLs.

Verify:
```bash
curl -s https://anchor-api.azurewebsites.us/healthz   # {"status":"ok","enclave":"gov"}
curl -s https://anchor-api.azurewebsites.us/readyz    # {"status":"ready"}
BASE_URL=https://anchor-api.azurewebsites.us/api/v1 scripts/smoke.sh
```

## 3. What the deployment configures (and how to change it)

### API Web App (`anchor-api`)
| App setting | Value | Notes |
|-------------|-------|-------|
| `WEBSITES_PORT` / `API_PORT` | `4000` | container listens on 4000 |
| `ENCLAVE` | `gov` | drives gov cloud behavior |
| `NODE_ENV` | `production` | disables dev-login |
| `WEB_ORIGIN` | `https://anchor-web.azurewebsites.us` | CORS allow-list |
| `DATABASE_URL` / `APP_DATABASE_URL` | **Key Vault reference** | owner (migrate) + non-owner runtime (RLS) |
| `SESSION_SIGNING_KEY` | **Key Vault reference** | `@Microsoft.KeyVault(SecretUri=…)` |
| `M365_ENABLED` | `false` | flip to `true` after step 4 |
| `M365_CLOUD` | `gcchigh` | gov endpoints (`graph.microsoft.us`) |

`healthCheckPath=/healthz`; App Service load-balances away unhealthy instances.

### Web Web App (`anchor-web`)
Next.js standalone; `WEBSITES_PORT=3000`; `NEXT_PUBLIC_API_BASE` is **baked at image build
time** (so to change the API URL, rebuild the web image with a new `--build-arg`).

### Secrets (Key Vault)
`session-signing-key`, `admin-db-url`, `app-db-url` are stored in the gov Key Vault; the
API's managed identity has **Key Vault Secrets User**. To rotate, update the secret and
restart the API. **Never** put real secrets in `parameters.gov.json`.

## 4. Configure Microsoft 365 (Government) — optional

In gov, Graph/Teams/email use **national-cloud endpoints** and behave differently
([06 §L](../../06-notifications-m365.md)). After validating against your tenant:

```bash
az webapp config appsettings set -g $RG -n anchor-api --settings \
  M365_ENABLED=true M365_CLOUD=gcchigh \
  M365_TENANT_ID=<gov-tenant-guid> M365_CLIENT_ID=<app-id> \
  M365_SERVICE_MAILBOX=<svc-mailbox-upn>
# Store M365_CLIENT_SECRET in Key Vault and reference it; or use certificate/managed-identity auth.
az webapp restart -g $RG -n anchor-api
```

Leave `M365_ENABLED=false` until the gov Graph/Teams/email paths are validated — Anchor
falls back to the **portal channel** (always recorded) and logs every substitution.

## 5. Production hardening (layer on)

- **Private networking:** VNet integration for both web apps + **Private Endpoints** for
  Postgres, Key Vault, and ACR; then remove the `AllowAzureServices` Postgres firewall rule
  and set `publicNetworkAccess=Disabled`.
- **Front Door (gov) + WAF** in front of the web app; restrict the app's public access to
  the Front Door.
- **Custom domain + managed cert:** `az webapp config hostname add` / `az webapp config
  ssl create`.
- **Scale:** `az appservice plan update --sku P2v3 --number-of-workers N`, or enable
  autoscale rules on the plan.
- **HA/DR:** zone-redundant plan + zone-redundant Postgres; geo-redundant backup within the
  gov boundary; quarterly restore drill with `scripts/db-restore.sh`.
- **Identity:** replace dev-login/local accounts with **Entra ID (gov)** OIDC against
  `login.microsoftonline.us`; Anchor's token-validation seam is in `apps/api/src/auth/`.
- **Migrations in CI:** run the one-off migrate from a pipeline runner with VNet
  line-of-sight to Postgres (Private Endpoint) instead of the temporary-admin path in
  `deploy-gov.sh`.

## 6. Manual portal alternative (if you can't run the script)

1. **Create RG** in a gov region.
2. **Create ACR** (Standard). Build/push:
   `az acr build -r <acr> -t anchor-api:latest -f apps/api/Dockerfile .` and the web image
   with `--build-arg NEXT_PUBLIC_API_BASE=https://<api>.azurewebsites.us/api/v1`.
3. **Create Postgres Flexible Server 16** + database `nexus`; allow Azure services.
4. **Create Key Vault**; add `session-signing-key`, `admin-db-url`, `app-db-url`.
5. **Create a Linux App Service plan** (P1v3).
6. **Create two Web Apps for Containers** (api → ACR `anchor-api`, web → `anchor-web`);
   enable **system-assigned identity**; grant **AcrPull** on the ACR and **Key Vault
   Secrets User** on the vault.
7. Set the **app settings** from §3 (use Key Vault references for secrets); set
   **health check path** (`/healthz` for api).
8. Run **migrate + seed** once (Cloud Shell / a one-off container / pipeline).
9. **Restart** both apps; verify `/healthz` and `/readyz`.

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `/readyz` → 503 `database_unavailable` | App can't reach Postgres — check the firewall/Private Endpoint and the `*-db-url` Key Vault secrets/SSL (`sslmode=require`). |
| Web app won't start / "image pull failed" | Image not yet in ACR, or `AcrPull` role not assigned — rebuild with `az acr build`, confirm the role on the site's identity. |
| `401`/`403` on Key Vault reference | The site's managed identity lacks **Key Vault Secrets User**, or the secret URI is wrong. |
| Login works in dev but not here | Correct — `NODE_ENV=production` disables dev-login; configure Entra ID (gov) OIDC. |
| Container logs | `az webapp log tail -g $RG -n anchor-api` |

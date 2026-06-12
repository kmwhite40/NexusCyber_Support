# Deploy Anchor as "Code" on Azure Gov App Service (Node 20-LTS) — like your M365GCC app

Your existing **M365GCC** app is **Publish = Code · Runtime = Node 20-LTS · Linux · F1**.
Anchor **can** deploy the same way. This guide covers it, with the one structural fact to
plan around and the changes already made to support it.

## Can the code support it? Yes — with two facts to plan around

1. **One App Service runs one Node process.** Anchor is **two** apps (API + Web). The
   M365GCC pattern = **two** web apps: `anchor-api` and `anchor-web` (each Code/Node 20-LTS,
   like M365GCC). If you only want a single app, deploy `anchor-web` here and host the API
   separately.
2. **Both apps now honor Azure's injected `PORT`** (changes shipped):
   - API: `config.port` reads `process.env.PORT` first.
   - Web: `npm start` → `next start -p ${PORT:-3000}`.

> **Tier note:** your M365GCC is **F1 (Free)** — no Always On, 1 instance, ~60 CPU-min/day,
> 1 GB. That's fine for the **Web** as a demo, but the **API** (DB-backed, runs migrations)
> needs at least **B1**. Use a Basic/Standard plan for `anchor-api`.

---

## A) Web app (Next.js) as Code — the clean match to M365GCC

**Create Web App → Basics:** Publish **Code**, Runtime **Node 20 LTS**, OS **Linux**,
Region **USGov Virginia**, your plan.

**Before first deploy — App settings** (Settings → Environment variables):
| Setting | Value | Why |
|---------|-------|-----|
| `NEXT_PUBLIC_API_BASE` | `https://<your-api-host>.azurewebsites.us/api/v1` | **Inlined at build time** — must be set *before* the build runs |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | let Oryx run `npm install` + `npm run build` |

**Deploy** (Deployment Center → GitHub, or zip deploy). Oryx runs `npm install` then
`npm run build` (`next build`). **Startup Command** (Settings → Configuration → General):
```
npm run start
```
(`next start -p ${PORT:-3000}` — honors App Service's port).

> Monorepo: point the deploy at **`apps/web`** (set the GitHub Action working-directory to
> `apps/web`, or zip-deploy the `apps/web` folder). Don't deploy the repo root for the web app.

---

## B) API (Fastify/TypeScript) as Code

Supported, but fiddlier than a container (TS build + bundled SQL migrations + Postgres).
**Recommended:** run the API as a **container** (`infra/azure/webapp-gov.bicep` /
`azure-gov-webapp.md`). If you specifically want Code/Node 20-LTS:

**Basics:** Publish **Code**, Runtime **Node 20-LTS**, OS **Linux**, plan **B1+**.

**App settings:**
| Setting | Value |
|---------|-------|
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |
| `POST_BUILD_COMMAND` | `cp src/db/migrations/*.sql dist/db/migrations/` (tsc doesn't emit `.sql`) |
| `ENCLAVE` | `gov` |
| `NODE_ENV` | `production` |
| `WEB_ORIGIN` | `https://anchor-web.azurewebsites.us` |
| `DATABASE_URL`, `APP_DATABASE_URL` | Postgres URLs (Key Vault references preferred) |
| `SESSION_SIGNING_KEY` | Key Vault reference |

**Startup Command** (runs the idempotent migrations, then the server):
```
sh -c "node apps/api/dist/db/migrate.js && node apps/api/dist/server.js"
```
Seed once from SSH (App Service → SSH): `node apps/api/dist/db/seed.js`.

> Deploy the **`apps/api`** folder (Oryx builds where `package.json` is). The build runs
> `tsc`; `POST_BUILD_COMMAND` copies the migrations into `dist/`.

---

## C) GitHub Actions deploy with Entra OIDC (no basic auth)

Gov tenants commonly **disable basic authentication** (so "Get publish profile" is blocked).
The workflow [`.github/workflows/azure-webapp-code.yml`](../../../../.github/workflows/azure-webapp-code.yml)
therefore authenticates with **Entra ID OIDC** (federated credentials — no stored secret,
no basic auth) and zip-deploys via the AAD-authenticated Kudu endpoint.

**One-time setup (run in the Azure Government cloud):**
```bash
az cloud set --name AzureUSGovernment && az login
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)

# 1) App registration + service principal
APP_ID=$(az ad app create --display-name anchor-gha --query appId -o tsv)
az ad sp create --id "$APP_ID"

# 2) Federated credential for GitHub (adjust branch/subject as needed)
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-feat",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:kmwhite40/NexusCyber_Support:ref:refs/heads/feat/nexus-platform",
  "audiences": ["api://AzureADTokenExchange"]
}'

# 3) Grant deploy rights on the web app (Website Contributor; or Contributor on the RG)
SP_OID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
APP_RID=$(az webapp show -g M365_Compliance -n Anchor --query id -o tsv)
az role assignment create --assignee-object-id "$SP_OID" --assignee-principal-type ServicePrincipal \
  --role "Website Contributor" --scope "$APP_RID"

echo "AZURE_CLIENT_ID=$APP_ID  AZURE_TENANT_ID=$TENANT  AZURE_SUBSCRIPTION_ID=$SUB"
```

**Repo → Settings → Secrets and variables → Actions:**
- secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- variables: `AZURE_WEBAPP_NAME` = `Anchor`, `NEXT_PUBLIC_API_BASE` = `https://anchor-api.azurewebsites.us/api/v1`

Then **Actions → "Deploy Web (Code)…" → Run workflow** on your branch.

> **Alternative (only if policy allows):** re-enable basic auth on the app
> (Settings → Configuration → General settings → **SCM Basic Auth Publishing Credentials = On**),
> then a publish-profile deploy also works. OIDC is preferred for gov — no stored credential.

---

## The "deprecated runtime" warning

Anchor targets **Node ≥ 20** (`package.json` engines). Node 20-LTS is fine. If Azure Gov
offers **Node 22-LTS**, you can select it — the code runs on 20 and 22. The warning on your
current M365GCC is about *its* configured stack; recreating on **Node 20-LTS** (or 22) clears it.

## Which path should you pick?

| | Web | API |
|---|-----|-----|
| **Code / Node 20-LTS** (M365GCC-style) | ✅ clean — recommended | ⚠️ works, but build+migrations are fiddly |
| **Container** (this repo's primary path) | ✅ | ✅ **recommended** (migrations bundled, one image, validated) |

Easiest overall: **Web = Code** (matches M365GCC), **API = Container**. Both are documented here
and in [azure-gov-webapp.md](./azure-gov-webapp.md).

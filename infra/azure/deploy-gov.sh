#!/usr/bin/env bash
# Deploy Anchor to Azure GOVERNMENT App Service (Web App for Containers), GCC/.us.
# Provisions infra (Bicep), builds images in ACR (no local Docker), migrates+seeds,
# and restarts the web apps. Run from the repo root with the Azure CLI installed.
#
#   PG_ADMIN_PASSWORD=... APP_DB_PASSWORD=... SESSION_KEY=... \
#   RG=anchor-gov-rg LOCATION=usgovvirginia infra/azure/deploy-gov.sh
set -euo pipefail

RG="${RG:-anchor-gov-rg}"
LOCATION="${LOCATION:-usgovvirginia}"
NAME="${NAME:-anchor}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
SUBSCRIPTION="${SUBSCRIPTION:-}"
DEPLOY="anchor-webapp-gov"

: "${PG_ADMIN_PASSWORD:?set PG_ADMIN_PASSWORD (Postgres admin)}"
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD (runtime nexus_app role)}"
: "${SESSION_KEY:?set SESSION_KEY (session signing key)}"

echo "==> Target the Azure US Government cloud"
az cloud set --name AzureUSGovernment
az account show >/dev/null 2>&1 || az login
[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION"

echo "==> Resource group: $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Provision infra (ACR, Key Vault, Postgres, plan, web apps)…"
az deployment group create -g "$RG" --name "$DEPLOY" \
  -f infra/azure/webapp-gov.bicep \
  -p name="$NAME" location="$LOCATION" imageTag="$TAG" \
     pgAdminPassword="$PG_ADMIN_PASSWORD" appDbPassword="$APP_DB_PASSWORD" sessionSigningKey="$SESSION_KEY" \
  -o none

q() { az deployment group show -g "$RG" -n "$DEPLOY" --query "properties.outputs.$1.value" -o tsv; }
ACR_SERVER="$(q acrLoginServer)"; ACR_NAME="${ACR_SERVER%%.*}"
API_URL="$(q apiUrl)"; WEB_URL="$(q webUrl)"; PG_FQDN="$(q postgresFqdn)"
echo "    ACR=$ACR_SERVER  API=$API_URL  WEB=$WEB_URL"

echo "==> Build & push images in ACR (in-region build; no local Docker)…"
az acr build -r "$ACR_NAME" -t "anchor-api:$TAG" -f apps/api/Dockerfile .
az acr build -r "$ACR_NAME" -t "anchor-web:$TAG" \
  --build-arg "NEXT_PUBLIC_API_BASE=${API_URL}/api/v1" -f apps/web/Dockerfile .

echo "==> Migrate + seed (one-off container)…"
ADMIN_URL="postgres://nexus:${PG_ADMIN_PASSWORD}@${PG_FQDN}:5432/nexus?sslmode=require"
APP_URL="postgres://nexus_app:${APP_DB_PASSWORD}@${PG_FQDN}:5432/nexus?sslmode=require"
# Briefly enable ACR admin so the one-off ACI can pull, then disable. In a hardened
# setup, run this step from a pipeline runner / jumpbox with VNet line-of-sight to
# Postgres instead (Private Endpoint) and skip admin entirely.
az acr update -n "$ACR_NAME" --admin-enabled true -o none
ACR_USER="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
az container create -g "$RG" --name anchor-migrate --os-type Linux --restart-policy Never \
  --image "${ACR_SERVER}/anchor-api:${TAG}" \
  --registry-login-server "$ACR_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
  --command-line "sh -c 'node dist/db/migrate.js && node dist/db/seed.js'" \
  --secure-environment-variables DATABASE_URL="$ADMIN_URL" APP_DATABASE_URL="$APP_URL" -o none
sleep 5
az container logs -g "$RG" --name anchor-migrate || true
az container delete -g "$RG" --name anchor-migrate --yes -o none
az acr update -n "$ACR_NAME" --admin-enabled false -o none

echo "==> Restart web apps to pull the new images…"
az webapp restart -g "$RG" -n "${NAME}-api" -o none
az webapp restart -g "$RG" -n "${NAME}-web" -o none

echo "==> Done."
echo "    API health: ${API_URL}/healthz   (also /readyz)"
echo "    Web:        ${WEB_URL}"
echo "    Verify:     BASE_URL=${API_URL}/api/v1 scripts/smoke.sh"

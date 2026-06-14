#!/usr/bin/env bash
#
# Deploy apps/api (Docker container) to the Azure Government App Service "anchor-api".
#
# Codifies the validated manual flow: build the image in ACR (ACR Tasks — no local
# Docker needed), pin the running container to the freshly-built DIGEST (immutable,
# avoids ":latest" cache ambiguity), restart, and verify /readyz returns ready.
#
# Prereqs:
#   - az CLI logged into AzureUSGovernment with access to anchor-gov-rg + the ACR
#       az cloud set --name AzureUSGovernment && az login
#
# Usage:
#   scripts/deploy-api.sh
#   RG=... APP=... ACR=... scripts/deploy-api.sh
set -euo pipefail

RG="${RG:-anchor-gov-rg}"
APP="${APP:-anchor-api}"
ACR="${ACR:-anchoracrxvcecept2lc66}"
IMAGE="${IMAGE:-anchor-api}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"

echo "▶ Deploying apps/api -> Azure Gov container app '$APP' (rg=$RG, acr=$ACR, tag=$TAG)"

# 0) Sanity: correct cloud + logged in.
az account show >/dev/null 2>&1 || { echo "✗ az not logged in: az cloud set --name AzureUSGovernment && az login" >&2; exit 1; }
cloud="$(az cloud show --query name -o tsv)"
[ "$cloud" = "AzureUSGovernment" ] || { echo "✗ az cloud is '$cloud', expected AzureUSGovernment" >&2; exit 1; }

# 1) Build + push in ACR (no local Docker).
echo "▶ Building image in ACR…"
az acr build --registry "$ACR" --image "$IMAGE:$TAG" --image "$IMAGE:latest" --file apps/api/Dockerfile "$ROOT" >/tmp/deploy-api-build.log 2>&1 \
  || { echo "✗ ACR build failed — see /tmp/deploy-api-build.log"; tail -20 /tmp/deploy-api-build.log; exit 1; }

# 2) Resolve the immutable digest and pin the container to it.
DIGEST="$(az acr repository show -n "$ACR" --image "$IMAGE:$TAG" --query digest -o tsv)"
[ -n "$DIGEST" ] || { echo "✗ could not resolve digest for $IMAGE:$TAG" >&2; exit 1; }
REF="$(az acr show -n "$ACR" --query loginServer -o tsv)/$IMAGE@$DIGEST"
echo "▶ Pinning $APP to $REF"
az webapp config container set -g "$RG" -n "$APP" --container-image-name "$REF" -o none

# 3) Restart and wait for readiness.
az webapp restart -g "$RG" -n "$APP"
host="$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
echo "▶ Waiting for https://$host/readyz …"
ready=""
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$host/readyz" || true)"
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 6
done
[ -n "$ready" ] || { echo "✗ $APP did not become ready" >&2; exit 1; }
echo "  healthz: $(curl -s "https://$host/healthz")"
echo "✓ Deployed apps/api ($TAG / ${DIGEST:0:19}) to https://$host"

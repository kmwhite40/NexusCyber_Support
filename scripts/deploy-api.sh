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
az acr build --registry "$ACR" --image "$IMAGE:$TAG" --image "$IMAGE:latest" \
  --build-arg "BUILD_SHA=$TAG" --file apps/api/Dockerfile "$ROOT" >/tmp/deploy-api-build.log 2>&1 \
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
# Wait for THIS BUILD to answer, not merely for something to return 200.
#
# During an App Service container swap the OLD container keeps serving, so polling /readyz until
# it returns 200 proves nothing about the image just pushed. That is not theoretical: a deploy
# printed its success line while the new container had not booted, and if its migrations had
# failed it would have printed the same line against a healthy old container with a crash-looping
# new one behind it. RUN_MIGRATIONS_ON_BOOT makes that failure mode entirely reachable — a
# migration that cannot apply aborts startup.
echo "▶ Waiting for https://$host/healthz to report build $TAG …"
live=""
last_seen=""
for _ in $(seq 1 60); do
  body="$(curl -s -m 10 "https://$host/healthz" || true)"
  last_seen="$(printf '%s' "$body" | sed -n 's/.*"build"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ "$last_seen" = "$TAG" ]; then live=1; break; fi
  sleep 6
done

if [ -z "$live" ]; then
  echo "✗ $APP is serving build '${last_seen:-<no build field>}', not '$TAG'." >&2
  echo "  The old container may still be serving, or the new one failed to start." >&2
  echo "  With RUN_MIGRATIONS_ON_BOOT=true a failing migration aborts startup — check:" >&2
  echo "    az webapp log download -g $RG -n $APP --log-file /tmp/anchor-logs.zip" >&2
  echo "  A '<no build field>' above means the running image predates build-stamping;" >&2
  echo "  deploy once more and it will report properly." >&2
  exit 1
fi

# Readiness (database reachable) — meaningful now that we know WHICH build answered.
code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://$host/readyz" || true)"
[ "$code" = "200" ] || { echo "✗ build $TAG is live but /readyz returned $code" >&2; exit 1; }
echo "  healthz: $(curl -s "https://$host/healthz")"
echo "✓ Deployed apps/api ($TAG / ${DIGEST:0:19}) to https://$host"

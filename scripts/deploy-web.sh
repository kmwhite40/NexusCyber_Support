#!/usr/bin/env bash
#
# Deploy apps/web (Next.js standalone) to the Azure Government App Service.
#
# This codifies the validated manual deploy: the "Anchor" web app is a Node 22 code app
# whose startup is `node server.js` with SCM_DO_BUILD_DURING_DEPLOYMENT=false, so it expects
# a PRE-BUILT, flattened Next.js standalone bundle (server.js at the package root). The
# public API base is baked into the client bundle at build time (NEXT_PUBLIC_API_BASE).
#
# Prereqs:
#   - az CLI logged into AzureUSGovernment with access to the web app
#       az cloud set --name AzureUSGovernment && az login
#   - Node 20+ / npm
#
# Usage:
#   scripts/deploy-web.sh                  # deploy to the defaults below
#   RG=... APP=... API_BASE=... scripts/deploy-web.sh
#
set -euo pipefail

RG="${RG:-M365_Compliance}"
APP="${APP:-Anchor}"
API_BASE="${API_BASE:-https://anchor-api.azurewebsites.us/api/v1}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/apps/web"
PKG="$WEB/.deploy"
ZIP="$WEB/deploy.zip"
# Build into an ISOLATED output dir so a deploy never clobbers a running `next dev`'s .next
# cache (next.config.mjs honours NEXT_DIST_DIR; the standalone server bakes this distDir in).
DIST="${NEXT_DIST_DIR:-.next-deploy}"

echo "▶ Deploying apps/web -> Azure Gov app '$APP' (rg=$RG)"
echo "  API base baked into bundle: $API_BASE"

# 0) Sanity: correct cloud + logged in.
if ! az account show >/dev/null 2>&1; then
  echo "✗ az is not logged in. Run: az cloud set --name AzureUSGovernment && az login" >&2
  exit 1
fi
cloud="$(az cloud show --query name -o tsv)"
[ "$cloud" = "AzureUSGovernment" ] || { echo "✗ az cloud is '$cloud', expected AzureUSGovernment" >&2; exit 1; }

# 1) Build the standalone bundle with the production API base.
echo "▶ Building (next build, output: standalone)…"
( cd "$WEB" && rm -rf "$DIST" && NEXT_DIST_DIR="$DIST" NEXT_PUBLIC_API_BASE="$API_BASE" npx next build >/tmp/deploy-web-build.log 2>&1 ) \
  || { echo "✗ build failed — see /tmp/deploy-web-build.log"; tail -20 /tmp/deploy-web-build.log; exit 1; }

# Guardrail: the prod API base must be baked in and localhost must NOT leak into the client.
grep -rlq "${API_BASE#https://}" "$WEB/$DIST/static" || { echo "✗ API base not found in client bundle" >&2; exit 1; }
if grep -rlq "localhost:4000" "$WEB/$DIST/static" 2>/dev/null; then
  echo "✗ localhost:4000 leaked into the client bundle — aborting" >&2; exit 1
fi

# 2) Assemble the FLATTENED standalone package (server.js at root), matching the app's
#    `node server.js` startup. Monorepo standalone nests server.js under apps/web and hoists
#    node_modules to the standalone root; flatten them together and merge static + public.
echo "▶ Packaging standalone bundle…"
rm -rf "$PKG" "$ZIP"
mkdir -p "$PKG"
cp -a "$WEB/$DIST/standalone/apps/web/." "$PKG/"
cp -a "$WEB/$DIST/standalone/node_modules" "$PKG/node_modules"
# Static must live under the same distDir the standalone server.js baked in (./$DIST/static).
mkdir -p "$PKG/$DIST/static" && cp -a "$WEB/$DIST/static/." "$PKG/$DIST/static/"
[ -d "$WEB/public" ] && cp -a "$WEB/public" "$PKG/public"
cp -a "$WEB/$DIST/standalone/package.json" "$PKG/package.json" 2>/dev/null || cp -a "$WEB/package.json" "$PKG/package.json"
[ -f "$PKG/server.js" ] || { echo "✗ server.js missing from package root" >&2; exit 1; }
( cd "$PKG" && zip -qr "$ZIP" . )
echo "  package: $(du -h "$ZIP" | cut -f1)"

# 3) Deploy (zip) and restart.
echo "▶ Deploying to Azure…"
az webapp deploy -g "$RG" -n "$APP" --src-path "$ZIP" --type zip --restart true \
  --query "{status:properties.status, ok:properties.numberOfInstancesSuccessful, failed:properties.numberOfInstancesFailed}" -o json

# 4) Verify.
host="$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
echo "▶ Verifying https://$host …"
sleep 8
code="$(curl -s -o /dev/null -w '%{http_code}' "https://$host/")"
echo "  homepage: HTTP $code"
[ "$code" = "200" ] || { echo "✗ site did not return 200" >&2; exit 1; }

# 5) Clean up local build artifacts (including the isolated build dir — never the dev .next).
rm -rf "$PKG" "$ZIP" "$WEB/$DIST"
echo "✓ Deployed apps/web to https://$host"

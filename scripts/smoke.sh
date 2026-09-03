#!/usr/bin/env bash
# Dependency-free post-deploy smoke check (operational runbook, docs/nexus/10 §X).
# Verifies the API is healthy, auth works, and the core read endpoints respond 200.
# Exit non-zero on the first failure so it can gate a deploy pipeline.
#
#   BASE_URL=http://localhost:4000/api/v1 scripts/smoke.sh
#   DEMO_EMAIL=agent@nexus.example.com   (override the demo identity)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000/api/v1}"
HEALTH_URL="${HEALTH_URL:-${BASE_URL%/api/v1}/healthz}"
READY_URL="${READY_URL:-${BASE_URL%/api/v1}/readyz}"
DEMO_EMAIL="${DEMO_EMAIL:-agent@nexus.example.com}"

green() { printf '\033[32m✓\033[0m %s\n' "$1"; }
red() { printf '\033[31m✗\033[0m %s\n' "$1"; }

fail=0
check() { # name url [expected_code]
  local name="$1" url="$2" want="${3:-200}" auth="${4:-}"
  local code
  if [ -n "$auth" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $auth" "$url")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  fi
  if [ "$code" = "$want" ]; then green "$name ($code)"; else red "$name (got $code, want $want)"; fail=1; fi
}

echo "Smoke testing $BASE_URL"
check "liveness  /healthz" "$HEALTH_URL"
check "readiness /readyz"  "$READY_URL"

# Authenticate (dev-login is non-production; swap for OIDC in prod).
TOKEN=$(curl -s -X POST "$BASE_URL/auth/dev-login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DEMO_EMAIL\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{process.stdout.write("")}})')

if [ -z "$TOKEN" ]; then red "auth dev-login (no token)"; exit 1; else green "auth dev-login"; fi

# Endpoints below work agent-wide without an organization scope. (Org-scoped reads
# like /posture/findings require ?organizationId=... for nexus agents, by design.)
check "GET /me"                 "$BASE_URL/me"                 200 "$TOKEN"
check "GET /tickets"            "$BASE_URL/tickets?limit=5"    200 "$TOKEN"
check "GET /analytics/overview" "$BASE_URL/analytics/overview" 200 "$TOKEN"
check "GET /conmon/runs"        "$BASE_URL/conmon/runs"        200 "$TOKEN"
check "GET /catalog"            "$BASE_URL/catalog"            200 "$TOKEN"
check "GET /oncall/schedules"   "$BASE_URL/oncall/schedules"   200 "$TOKEN"

if [ "$fail" -eq 0 ]; then green "ALL SMOKE CHECKS PASSED"; else red "SMOKE FAILED"; fi
exit "$fail"

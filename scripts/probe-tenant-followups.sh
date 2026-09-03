#!/usr/bin/env bash
#
# probe-tenant-followups.sh
#
# ============================================================================
#  READ-ONLY. This script issues ONLY HTTP GET requests against Microsoft
#  Graph (plus the one POST to the token endpoint that every client-credentials
#  flow requires). It never issues POST, PATCH, PUT, or DELETE against Graph
#  itself. Keep it that way: if you need to verify a WRITE, build it as an
#  explicit, separately-reviewed script — the same rule as
#  probe-provisioning-tenant.sh, which this is a companion to.
# ============================================================================
#
# Answers the open questions left by the offboarding work (phases 1 and 2) and
# by the CMDB Entra/Intune device sync, none of which has ever run against a
# real tenant. Every one of them is currently an ASSUMPTION in shipped-but-dark
# code, and each is cheap to settle here:
#
#   PROBE 1 — What permissions does this app registration ACTUALLY hold?
#     Decodes the `roles` claim from the issued access token. This is the
#     definitive answer, not what the portal shows as requested: a permission
#     that was requested but never admin-consented does not appear here.
#     Settles, in one place:
#       - revokeSignInSessions       needs User.ReadWrite.All or
#                                    User.RevokeSessions.All  (offboarding step 2)
#       - the account disable/rename needs User.ReadWrite.All
#       - group + DL removal         needs Group.ReadWrite.All
#       - the device sync            needs DeviceManagementManagedDevices.Read.All
#
#   PROBE 2 — Does Graph return 404 for a user object that does not exist?
#     The retention sweeper (phase 2) treats 404 as "account genuinely gone"
#     and anything else as "could not ask". If this tenant answers 403 or 400
#     instead, every retention check would be recorded as un-checkable and no
#     breach would ever be detected — silently, while the sweeper looked fine.
#
#   PROBE 3 — Is /deviceManagement/managedDevices reachable, and what does it
#     return? This is the entire foundation of the CMDB device sync. It also
#     prints the field names of one device so the mapper can be built against
#     the real payload shape rather than the documented one.
#
#   PROBE 4 — What does Graph expose about a mailbox?
#     Offboarding assumes there is NO Graph endpoint to convert a mailbox to
#     shared (it is Set-Mailbox -Type Shared in Exchange Online PowerShell), and
#     that a licensed account implies a user mailbox. Both are inferences. This
#     shows what mailboxSettings actually returns so the inference can be
#     replaced with a fact, or confirmed as the best available.
#
# ----------------------------------------------------------------------------
# Credentials (environment variables only — never hardcode, never logged)
# ----------------------------------------------------------------------------
#   M365_PROV_TENANT_ID
#   M365_PROV_CLIENT_ID
#   M365_PROV_CLIENT_SECRET
#   PROBE_SAMPLE_UPN   (optional) a real UPN to use for probes 2 and 4. Without
#                      it, probe 2 still runs against a synthetic object id and
#                      probe 4 is skipped.
#
# The secret is used exactly once, in a single token request, and is never
# echoed. This script never runs `set -x`. If you add debugging, do not print
# the token request or ACCESS_TOKEN.
#
set -uo pipefail

LOGIN_AUTHORITY="https://login.microsoftonline.us"
GRAPH="https://graph.microsoft.us"

TMPDIR_PROBE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_PROBE"' EXIT
new_tmp() { mktemp "${TMPDIR_PROBE}/probe.XXXXXX"; }

ok()   { echo "✓ $*"; }
warn() { echo "! $*"; }
bad()  { echo "✗ $*"; }
hr()   { echo "------------------------------------------------------------"; }

for tool in curl jq base64; do
  command -v "$tool" >/dev/null 2>&1 || { bad "$tool is required"; exit 1; }
done

: "${M365_PROV_TENANT_ID:?set M365_PROV_TENANT_ID}"
: "${M365_PROV_CLIENT_ID:?set M365_PROV_CLIENT_ID}"
: "${M365_PROV_CLIENT_SECRET:?set M365_PROV_CLIENT_SECRET}"
SAMPLE_UPN="${PROBE_SAMPLE_UPN:-}"

ACCESS_TOKEN=""
get_access_token() {
  local token_url="${LOGIN_AUTHORITY}/${M365_PROV_TENANT_ID}/oauth2/v2.0/token"
  local resp_file status
  resp_file="$(new_tmp)"
  status="$(curl -sS -o "$resp_file" -w '%{http_code}' \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=${M365_PROV_CLIENT_ID}" \
    --data-urlencode "client_secret=${M365_PROV_CLIENT_SECRET}" \
    --data-urlencode "scope=${GRAPH}/.default" \
    "$token_url" 2>/dev/null)" || status="000"
  if [ "$status" != "200" ]; then
    bad "Failed to acquire an access token (HTTP $status)."
    sed -e 's/"client_secret"[[:space:]]*:[[:space:]]*"[^"]*"/"client_secret":"[REDACTED]"/g' "$resp_file" >&2
    exit 1
  fi
  ACCESS_TOKEN="$(jq -r '.access_token // empty' "$resp_file")"
  [ -n "$ACCESS_TOKEN" ] || { bad "Token endpoint returned 200 with no access_token."; exit 1; }
  ok "Access token acquired (client credentials, tenant ${M365_PROV_TENANT_ID})."
}

GET_STATUS=""
GET_BODY_FILE=""
graph_get() {
  GET_BODY_FILE="$(new_tmp)"
  GET_STATUS="$(curl -sS -o "$GET_BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Accept: application/json" \
    "$1" 2>/dev/null)" || GET_STATUS="000"
}

echo "Tenant follow-up probe — READ ONLY (GET requests only)"
hr
get_access_token
hr

# ---------------------------------------------------------------------------
# PROBE 1 — the permissions actually granted
# ---------------------------------------------------------------------------
echo "PROBE 1: application permissions actually consented on this app"
echo
# A JWT is three base64url segments. We decode only the PAYLOAD (segment 2) and
# read only the `roles` claim. The token itself is never printed.
PAYLOAD="$(printf '%s' "$ACCESS_TOKEN" | cut -d. -f2)"
# base64url -> base64, and pad to a multiple of 4.
PAYLOAD="$(printf '%s' "$PAYLOAD" | tr '_-' '/+')"
case $(( ${#PAYLOAD} % 4 )) in 2) PAYLOAD="${PAYLOAD}==";; 3) PAYLOAD="${PAYLOAD}=";; esac
ROLES="$(printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null | jq -r '.roles // [] | sort | .[]' 2>/dev/null)"

if [ -z "$ROLES" ]; then
  warn "No 'roles' claim in the token — the app has NO application permissions consented."
  warn "Every Graph call the offboarding engine makes would fail with accessDenied."
else
  echo "$ROLES" | sed 's/^/    /'
fi
echo
echo "  What each shipped-but-dark feature needs:"
have() { echo "$ROLES" | grep -qx "$1"; }
check() { # $1 = permission, $2 = what it is for
  if have "$1"; then ok "  $1 — $2"; else bad "  $1 MISSING — $2"; fi
}
check "User.ReadWrite.All"                      "disable, rename, reclaim licences (offboarding 1,3,5)"
check "Group.ReadWrite.All"                     "remove group and DL memberships (offboarding 6)"
check "Organization.Read.All"                   "read subscribed SKUs"
if have "User.RevokeSessions.All" || have "User.ReadWrite.All"; then
  ok "  session revocation covered (User.RevokeSessions.All or User.ReadWrite.All)"
else
  bad "  NEITHER User.RevokeSessions.All NOR User.ReadWrite.All — offboarding step 2 (revoke"
  bad "  sessions) WILL FAIL AT RUNTIME on every run. This is the phase-1 open question."
fi
check "DeviceManagementManagedDevices.Read.All" "the CMDB device sync (not yet built)"
hr

# ---------------------------------------------------------------------------
# PROBE 2 — does a missing user really 404?
# ---------------------------------------------------------------------------
echo "PROBE 2: what Graph returns for a user object that does not exist"
echo
# A syntactically valid but almost certainly absent object id.
graph_get "${GRAPH}/v1.0/users/00000000-0000-0000-0000-000000000000?\$select=id"
echo "  GET /users/00000000-...-000000000000  ->  HTTP ${GET_STATUS}"
if [ "$GET_STATUS" = "404" ]; then
  ok "404 as assumed. The retention sweeper's accountExists() will correctly read"
  ok "a deleted account as GONE rather than as un-checkable."
else
  bad "NOT 404 — this tenant answers ${GET_STATUS}."
  bad "accountExists() treats anything that is not 404 as 'could not ask', so EVERY"
  bad "retention check would be recorded as un-checkable and no breach would ever be"
  bad "detected — silently, while the sweeper reported itself healthy."
  bad "ACTION: widen the 404 check in provisioning-graph.ts accountExists() to include ${GET_STATUS}."
  echo "  Body:"; jq -r '.error.code // .' "$GET_BODY_FILE" 2>/dev/null | sed 's/^/    /' | head -3
fi
hr

# ---------------------------------------------------------------------------
# PROBE 3 — the device sync's foundation
# ---------------------------------------------------------------------------
echo "PROBE 3: /deviceManagement/managedDevices — the CMDB device sync foundation"
echo
graph_get "${GRAPH}/v1.0/deviceManagement/managedDevices?\$top=1"
echo "  GET /deviceManagement/managedDevices?\$top=1  ->  HTTP ${GET_STATUS}"
if [ "$GET_STATUS" = "200" ]; then
  COUNT="$(jq -r '.value | length' "$GET_BODY_FILE" 2>/dev/null)"
  ok "Reachable. Devices returned in this page: ${COUNT}"
  if [ "${COUNT:-0}" != "0" ]; then
    echo "  Field names on the first device (build the mapper against THESE, not the docs):"
    jq -r '.value[0] | keys | .[]' "$GET_BODY_FILE" 2>/dev/null | sed 's/^/    /' | head -40
    echo
    echo "  The fields the sync design keys on:"
    jq -r '.value[0] | {azureADDeviceId, deviceName, operatingSystem, complianceState, userPrincipalName, serialNumber}' \
      "$GET_BODY_FILE" 2>/dev/null | sed 's/^/    /'
  else
    warn "Endpoint works but this tenant has NO managed devices enrolled."
    warn "The device sync would run and populate nothing — which makes the phase-3"
    warn "asset-return checklist empty for every departure. Worth knowing BEFORE building it."
  fi
else
  bad "Not reachable (HTTP ${GET_STATUS}). The device sync cannot work until this does."
  jq -r '.error.code // empty' "$GET_BODY_FILE" 2>/dev/null | sed 's/^/    /'
fi
hr

# ---------------------------------------------------------------------------
# PROBE 4 — what Graph knows about a mailbox
# ---------------------------------------------------------------------------
echo "PROBE 4: what Graph exposes about a mailbox (the shared-conversion question)"
echo
if [ -z "$SAMPLE_UPN" ]; then
  warn "Skipped — set PROBE_SAMPLE_UPN=<a real upn> to run this one."
  warn "Offboarding currently INFERS that a licensed account has a user mailbox,"
  warn "because Graph exposes no user-vs-shared discriminator. This probe is how"
  warn "you confirm that inference is still the best available."
else
  graph_get "${GRAPH}/v1.0/users/${SAMPLE_UPN}/mailboxSettings"
  echo "  GET /users/${SAMPLE_UPN}/mailboxSettings  ->  HTTP ${GET_STATUS}"
  if [ "$GET_STATUS" = "200" ]; then
    ok "Readable. Keys returned:"
    jq -r 'keys | .[]' "$GET_BODY_FILE" 2>/dev/null | sed 's/^/    /'
    echo
    echo "  If NONE of these indicates a shared vs user mailbox, the offboarding"
    echo "  inference (licensed => user mailbox) stands, and convert_shared_mailbox"
    echo "  correctly remains a MANUAL step. If one does, replace the inference."
  else
    warn "Not readable (HTTP ${GET_STATUS}) — likely needs MailboxSettings.Read."
    jq -r '.error.code // empty' "$GET_BODY_FILE" 2>/dev/null | sed 's/^/    /'
  fi
fi
hr

echo "Done. This script made GET requests only (plus the token request)."
echo
echo "What to do with the output:"
echo "  PROBE 1 — any MISSING line is a runtime failure waiting to happen in code"
echo "            that is already deployed (dark). Fix the consent before enabling."
echo "  PROBE 2 — a non-404 means accountExists() needs widening BEFORE retention"
echo "            holds are trusted, or breaches will never be detected."
echo "  PROBE 3 — no devices means the phase-3 asset checklist would be empty;"
echo "            decide whether the device sync is still worth building first."
echo "  PROBE 4 — confirms whether the mailbox inference stays or gets replaced."

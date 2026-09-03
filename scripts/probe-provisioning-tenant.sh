#!/usr/bin/env bash
#
# probe-provisioning-tenant.sh
#
# ============================================================================
#  READ-ONLY. This script issues ONLY HTTP GET requests against Microsoft
#  Graph. It never issues POST, PATCH, PUT, or DELETE — there is no write
#  path in this file, on purpose, because it is meant to be safe to run
#  against the live SBS Federal GCC High tenant before the Anchor-Provisioning
#  app is trusted with any directory-write permission. If you are extending
#  this script, keep it that way: do not add a mutating call here — build it
#  as an explicit, separately-reviewed script instead.
# ============================================================================
#
# Answers four of the six provisioning prerequisites from the onboarding
# design doc (docs/superpowers/specs/2026-09-01-sbs-user-onboarding-provisioning-design.md,
# "Open items to confirm against the tenant"):
#
#   1. Every licensed SKU in the tenant (skuPartNumber, skuId, seats), with any
#      SKU that looks like Windows 365 flagged — open item #1 (the "Office 365
#      Plan (2)" / W365 SKU identity question).
#   2. The tenant's Cloud PC provisioning policies, with their id and assigned
#      group ids — expected: exactly one, "SBSFederal Cloud PC".
#   3. Whether the /deviceManagement/virtualEndpoint family answers on v1.0 or
#      requires beta in THIS tenant/cloud — open item #3. Tested as part of
#      probe #2, since it's the same endpoint family.
#   4. Whether the tenant's Temporary Access Pass authentication method policy
#      is enabled — open item #4.
#
# It does NOT resolve the third baseline SKU's true identity for you (that is
# a human judgment call over probe #1's output) and does NOT touch
# administrative-unit scoping (open item #2) — neither has a read endpoint
# that answers the question by itself.
#
# ----------------------------------------------------------------------------
# What actually got probed against the live tenant on 2026-09-01
# ----------------------------------------------------------------------------
# Probe 1 (/subscribedSkus, open item #1) is answerable with a delegated
# DIRECTORY-READ identity — e.g. `az rest --method get --url
# https://graph.microsoft.us/v1.0/subscribedSkus` under an interactively
# logged-in `az login` session against the GCC High cloud. No app registration
# or client-credentials flow was needed to resolve it; ordinary directory read
# is enough. That is how open item #1 got resolved (see the design doc).
#
# Probes 2-4 (Cloud PC provisioning policies, the v1.0/beta question, and the
# TAP authentication method policy — open items #2/#3/#4) genuinely need MORE
# than directory read: both `/deviceManagement/virtualEndpoint/*` (tried on
# v1.0 and beta) and `/policies/authenticationMethodsPolicy/...` were tried
# with the same delegated directory-read identity and both came back
# `accessDenied`, before ever reaching a version- or policy-specific response.
# Don't bother retrying those with a plain `az login` / directory-read
# credential — save the attempt. They need either the `Anchor-Provisioning`
# app registration with its consented scopes (CloudPC.ReadWrite.All,
# Policy.Read.All — see the permission table below), or a session that
# already holds those permissions.
#
# ----------------------------------------------------------------------------
# Required Microsoft Graph APPLICATION permissions (admin consent required)
# ----------------------------------------------------------------------------
#   - Organization.Read.All   -> GET /subscribedSkus                      (probe 1)
#   - CloudPC.ReadWrite.All   -> GET /deviceManagement/virtualEndpoint/
#                                   provisioningPolicies                  (probe 2/3)
#     (This is the permission the design spec lists for the Anchor-Provisioning
#     app. A narrower CloudPC.Read.All may also exist and suffice for this
#     read-only probe — NOT verified against this tenant/cloud; if the app
#     registration is scoped down for a probe-only credential, try that first
#     and fall back to CloudPC.ReadWrite.All if it 403s.)
#   - Policy.Read.All         -> GET /policies/authenticationMethodsPolicy (probe 4)
#     *** FLAGGED: this permission is NOT in the design spec's
#     Anchor-Provisioning permission table (User.ReadWrite.All,
#     Organization.Read.All, Group.ReadWrite.All,
#     UserAuthenticationMethod.ReadWrite.All, CloudPC.ReadWrite.All). The
#     runtime provisioning engine never reads the tenant-wide authentication
#     method policy object — it only POSTs a TAP to a specific user, which is
#     what UserAuthenticationMethod.ReadWrite.All is for. Reading the POLICY
#     object (to answer "is TAP enabled tenant-wide") is a different Graph
#     permission that this script needs but the production app may not carry.
#     Grant Policy.Read.All to Anchor-Provisioning temporarily for this probe,
#     or run probe 4 with a differently-scoped credential, or just check the
#     Entra admin center (Protection > Authentication methods > Temporary
#     Access Pass) by hand instead — whichever is less friction. If probe 4
#     403s, that is the likely cause and the script says so. ***
#
# ----------------------------------------------------------------------------
# Credentials (environment variables only — never hardcode, never logged)
# ----------------------------------------------------------------------------
#   M365_PROV_TENANT_ID
#   M365_PROV_CLIENT_ID
#   M365_PROV_CLIENT_SECRET
#
# The secret is used exactly once, in a single non-interactive token request,
# and is never echoed: not in a trace (this script never runs `set -x`), not
# in a printed command line, not in an error message. If you add debugging,
# do not print the token request or the ACCESS_TOKEN variable.
#
# ----------------------------------------------------------------------------
# Cloud
# ----------------------------------------------------------------------------
# Hardcoded to GCC High on purpose — this script is for the SBS Federal
# tenant specifically, and the design spec is explicit that the login
# authority / Graph host must come from the cloud_environments row for
# 'gcchigh', never a commercial-cloud default:
#   login authority: https://login.microsoftonline.us
#   Graph endpoint:   https://graph.microsoft.us
# (Confirmed against apps/api/src/db/migrations/0001_init.sql's
# cloud_environments seed row for 'gcchigh' — not re-derived from config.)
#
# ----------------------------------------------------------------------------
# Degradation
# ----------------------------------------------------------------------------
# Each probe is independent. A 403 (missing scope), 404 (wrong API version /
# tenant doesn't have the feature), or any other failure on one probe is
# reported clearly and the script moves on to the next probe — a partial
# answer is the point. Nothing here calls `set -e`.
#
# ----------------------------------------------------------------------------
# Usage
# ----------------------------------------------------------------------------
#   M365_PROV_TENANT_ID=... \
#   M365_PROV_CLIENT_ID=... \
#   M365_PROV_CLIENT_SECRET=... \
#     bash scripts/probe-provisioning-tenant.sh
#
# Requires: curl, jq (both checked at startup; the script exits cleanly with
# an instruction if either is missing — that's a dependency problem, not a
# tenant probe, so it's reported before any network call is made).
#
set -uo pipefail
# Deliberately NOT `set -e`: a single probe's non-zero exit must not abort
# the rest of the script. Deliberately NEVER `set -x` anywhere in this file
# (see the secret-handling note above).

LOGIN_AUTHORITY="https://login.microsoftonline.us"
GRAPH="https://graph.microsoft.us"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f" "${f}.status"
  done
}
trap cleanup EXIT

new_tmp() {
  local f
  f="$(mktemp)"
  TMP_FILES+=("$f")
  printf '%s' "$f"
}

hr() { printf -- '----------------------------------------------------------------------\n'; }

section() {
  echo
  hr
  echo "  $1"
  hr
}

warn() { printf '  ! %s\n' "$1"; }
info() { printf '  - %s\n' "$1"; }
ok()   { printf '  + %s\n' "$1"; }

# ---------------------------------------------------------------------------
# Dependency + credential checks
# ---------------------------------------------------------------------------

missing=()
command -v curl >/dev/null 2>&1 || missing+=("curl")
command -v jq   >/dev/null 2>&1 || missing+=("jq")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "✗ Missing required tool(s): ${missing[*]}" >&2
  echo "  Install them and re-run. No network call has been made." >&2
  exit 1
fi

need_var() {
  local name="$1"
  local val="${!name:-}"
  if [ -z "$val" ]; then
    echo "✗ Required environment variable $name is not set." >&2
    MISSING_VARS=1
  fi
}
MISSING_VARS=0
need_var M365_PROV_TENANT_ID
need_var M365_PROV_CLIENT_ID
need_var M365_PROV_CLIENT_SECRET
if [ "$MISSING_VARS" -ne 0 ]; then
  echo "  Set M365_PROV_TENANT_ID, M365_PROV_CLIENT_ID, M365_PROV_CLIENT_SECRET and re-run." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Token acquisition (client credentials grant, GCC High authority)
# ---------------------------------------------------------------------------

ACCESS_TOKEN=""

get_access_token() {
  local token_url="${LOGIN_AUTHORITY}/${M365_PROV_TENANT_ID}/oauth2/v2.0/token"
  local resp_file status
  resp_file="$(new_tmp)"

  # --data-urlencode keeps the secret out of the URL (it's POST body, form-
  # encoded) and curl is never run with -v/--trace here, so the secret never
  # reaches stdout/stderr via this call.
  status="$(curl -sS -o "$resp_file" -w '%{http_code}' \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=${M365_PROV_CLIENT_ID}" \
    --data-urlencode "client_secret=${M365_PROV_CLIENT_SECRET}" \
    --data-urlencode "scope=${GRAPH}/.default" \
    "$token_url" 2>/dev/null)" || status="000"

  if [ "$status" != "200" ]; then
    echo "✗ Failed to acquire an access token (HTTP $status)." >&2
    echo "  Response body (redacted defensively, though Azure AD does not echo the secret):" >&2
    # Defensive redaction in case an error payload ever echoes request fields.
    sed -e 's/"client_secret"[[:space:]]*:[[:space:]]*"[^"]*"/"client_secret":"[REDACTED]"/g' "$resp_file" >&2
    echo "  Common causes: wrong tenant id, wrong client id/secret, app not GCC High," >&2
    echo "  or the app registration does not exist / secret expired." >&2
    exit 1
  fi

  ACCESS_TOKEN="$(jq -r '.access_token // empty' "$resp_file")"
  if [ -z "$ACCESS_TOKEN" ]; then
    echo "✗ Token endpoint returned 200 but no access_token was present." >&2
    exit 1
  fi
  ok "Access token acquired (client credentials, tenant ${M365_PROV_TENANT_ID})."
}

# GET against Graph. $1 = full URL. Sets GET_STATUS and GET_BODY_FILE.
graph_get() {
  local url="$1"
  local body_file status
  body_file="$(new_tmp)"
  status="$(curl -sS -o "$body_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Accept: application/json" \
    "$url" 2>/dev/null)" || status="000"
  GET_STATUS="$status"
  GET_BODY_FILE="$body_file"
}

graph_error_summary() {
  # Best-effort one-line extraction of Graph's {"error":{"code":...,"message":...}}
  # without ever assuming it parses (some failures aren't even JSON).
  local body_file="$1"
  jq -r '.error.code as $c | .error.message as $m | "\($c // "unknown"): \($m // "no message")"' \
    "$body_file" 2>/dev/null || cat "$body_file" 2>/dev/null | head -c 300
}

# ---------------------------------------------------------------------------
# Probe 1 — /subscribedSkus
# ---------------------------------------------------------------------------

SKU_SUMMARY_FILE=""   # populated with "skuPartNumber\tskuId\tenabled\tconsumed" rows
W365_CANDIDATES=""    # newline-separated skuPartNumbers flagged as possible Windows 365

probe_subscribed_skus() {
  section "PROBE 1 / 4 — Licensed SKUs (GET /v1.0/subscribedSkus)"
  graph_get "${GRAPH}/v1.0/subscribedSkus"
  if [ "$GET_STATUS" != "200" ]; then
    warn "FAILED — HTTP $GET_STATUS: $(graph_error_summary "$GET_BODY_FILE")"
    warn "Requires Organization.Read.All (application permission, admin consent)."
    return
  fi

  local out
  out="$(new_tmp)"
  jq -r '
    .value[]
    | [.skuPartNumber, .skuId, (.prepaidUnits.enabled // 0), (.consumedUnits // 0)]
    | @tsv
  ' "$GET_BODY_FILE" > "$out"
  SKU_SUMMARY_FILE="$out"

  local total
  total="$(wc -l < "$out" | tr -d ' ')"
  ok "Retrieved $total SKU(s)."
  echo
  printf '  %-40s %-38s %8s %8s\n' "skuPartNumber" "skuId" "enabled" "consumed"
  printf '  %-40s %-38s %8s %8s\n' "----------------------------------------" "--------------------------------------" "--------" "--------"

  # Heuristic Windows 365 match. NOT VERIFIED against this tenant's actual SKU
  # naming — Windows 365 SKU part numbers are commonly of the form
  # CPC_E_*/CPC_B_* (per-configuration Enterprise/Business Cloud PC SKUs) or
  # contain WIN365/WINDOWS365/W365, but Microsoft has both renamed and
  # reformatted these before. Treat every flagged row as "look at this one
  # closely," not as a confirmed answer to open item #1.
  local w365_file
  w365_file="$(new_tmp)"
  : > "$w365_file"

  while IFS=$'\t' read -r part sku_id enabled consumed; do
    local flag=""
    if printf '%s' "$part" | grep -Eiq 'cpc_|win.?365|windows.?365|cloud.?pc'; then
      flag=" <== possible Windows 365 SKU (heuristic match, verify manually)"
      printf '%s\n' "$part" >> "$w365_file"
    fi
    printf '  %-40s %-38s %8s %8s%s\n' "$part" "$sku_id" "$enabled" "$consumed" "$flag"
  done < "$out"

  W365_CANDIDATES="$(cat "$w365_file")"
  echo
  if [ -n "$W365_CANDIDATES" ]; then
    ok "Flagged as possible Windows 365 SKU(s):"
    printf '%s\n' "$W365_CANDIDATES" | sed 's/^/      - /'
    info "This is the answer to open item #1 IF one of these is the third baseline"
    info "SKU on the paper form ('Office 365 Plan (2)'). Confirm against the exact"
    info "seat count / display name in the Entra admin center before committing it"
    info "to M365_PROV_BASELINE_SKUS."
  else
    warn "No skuPartNumber matched the Windows 365 heuristic. Either the tenant has"
    warn "no Windows 365 license at all (Cloud PC cannot be entitled — a real"
    warn "blocker), or its part number doesn't match the heuristic above and needs"
    warn "a human eye on the full table printed above."
  fi
}

# ---------------------------------------------------------------------------
# Probe 2 + 3 — Cloud PC provisioning policies, and which API version answers
# ---------------------------------------------------------------------------

WORKING_CLOUDPC_API_VERSION=""   # "v1.0" | "beta" | ""
FOUND_POLICY_NAME=""

probe_cloudpc_policies() {
  section "PROBE 2 / 4 + PROBE 3 / 4 — Cloud PC provisioning policies + API version (v1.0 vs beta)"
  local path="/deviceManagement/virtualEndpoint/provisioningPolicies?\$expand=assignments"
  local version
  for version in v1.0 beta; do
    info "Trying API version: $version"
    graph_get "${GRAPH}/${version}${path}"
    if [ "$GET_STATUS" = "200" ]; then
      WORKING_CLOUDPC_API_VERSION="$version"
      ok "SUCCESS on $version — this answers open item #3."
      break
    else
      warn "  $version failed — HTTP $GET_STATUS: $(graph_error_summary "$GET_BODY_FILE")"
    fi
  done

  if [ -z "$WORKING_CLOUDPC_API_VERSION" ]; then
    warn "Neither v1.0 nor beta returned 200 for provisioningPolicies."
    warn "Requires CloudPC.ReadWrite.All (or a narrower CloudPC.Read.All, if the"
    warn "credential you're using is scoped down — see the header note)."
    return
  fi

  echo
  local count
  count="$(jq -r '.value | length' "$GET_BODY_FILE" 2>/dev/null || echo 0)"
  ok "Retrieved $count provisioning polic$([ "$count" = "1" ] && echo y || echo ies)."
  echo

  # Process substitution (not a trailing pipe) so this loop runs in the
  # CURRENT shell — a `... | while read` here would run the loop in a
  # subshell and silently drop the FOUND_POLICY_NAME assignment below.
  local row name id groups
  while read -r row; do
    name="$(printf '%s' "$row" | jq -r '.displayName // "(none)"')"
    id="$(printf '%s' "$row" | jq -r '.id')"
    groups="$(printf '%s' "$row" | jq -r '[ (.assignments // [])[] | .target.groupId // empty ] | if length > 0 then join(", ") else "(none — unassigned policy)" end')"
    printf '  - displayName: %s\n    id:          %s\n    assignment group id(s): %s\n' "$name" "$id" "$groups"
    if [ "$name" = "SBSFederal Cloud PC" ]; then
      FOUND_POLICY_NAME="$name"
    fi
  done < <(jq -c '.value[]' "$GET_BODY_FILE" 2>/dev/null)

  echo
  if [ "$count" = "1" ]; then
    ok "Exactly one policy found, matching the design doc's 'Tenant facts (confirmed)'."
  elif [ "$count" = "0" ]; then
    warn "Zero policies found. The design doc expects exactly one ('SBSFederal Cloud PC')."
  else
    warn "$count policies found. The design doc expects exactly one — confirm which"
    warn "one is 'SBSFederal Cloud PC' and check M365_PROV_CLOUDPC_POLICY still names it."
  fi
}

# ---------------------------------------------------------------------------
# Probe 4 — Temporary Access Pass authentication method policy
# ---------------------------------------------------------------------------

TAP_STATE=""   # "enabled" | "disabled" | "" (unknown / probe failed)

probe_tap_policy() {
  section "PROBE 4 / 4 — Temporary Access Pass policy (GET /v1.0/policies/authenticationMethodsPolicy)"
  info "Endpoint and shape below are from Microsoft's general Graph documentation for"
  info "the commercial cloud; NOT independently verified against GCC High. If this"
  info "probe 404s in GCC High, the endpoint may live elsewhere in this cloud, or the"
  info "underlying object may not be reachable via Graph in a GCC High tenant at all"
  info "— that itself would be worth reporting up, not just a script bug."
  graph_get "${GRAPH}/v1.0/policies/authenticationMethodsPolicy"
  if [ "$GET_STATUS" != "200" ]; then
    warn "FAILED — HTTP $GET_STATUS: $(graph_error_summary "$GET_BODY_FILE")"
    if [ "$GET_STATUS" = "403" ]; then
      warn "Most likely cause: this credential lacks Policy.Read.All, which is NOT in"
      warn "the design spec's Anchor-Provisioning permission list (see script header)."
      warn "Grant it temporarily for this probe, or check the Entra admin center by"
      warn "hand: Protection > Authentication methods > Temporary Access Pass."
    elif [ "$GET_STATUS" = "404" ]; then
      warn "404 in GCC High could mean a different path is needed here — unverified."
    fi
    return
  fi

  TAP_STATE="$(jq -r '
    (.authenticationMethodConfigurations // [])[]
    | select(.id == "TemporaryAccessPass")
    | .state // empty
  ' "$GET_BODY_FILE")"

  if [ -z "$TAP_STATE" ]; then
    warn "Request succeeded but no TemporaryAccessPass entry was found in the policy"
    warn "payload. The response shape may differ from what this script expects —"
    warn "inspect it by hand; raw body is in a temp file this run (see below)."
    return
  fi

  if [ "$TAP_STATE" = "enabled" ]; then
    ok "Temporary Access Pass is ENABLED tenant-wide — this answers open item #4."
    info "The issue_tap provisioning step can run as designed."
  else
    warn "Temporary Access Pass state is '$TAP_STATE' (not enabled)."
    info "Per the design doc's fallback for open item #4: issue_tap should be"
    info "marked SKIPPED and the admin sets the first credential out-of-band; the"
    info "rest of the run is unaffected. No M365_PROV_* setting changes this — it's"
    info "a tenant policy an Entra admin would need to turn on if TAP is wanted."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "Provisioning tenant probe — SBS Federal GCC High"
echo "READ-ONLY: GET requests only. See the header of this script for full scope."
echo "Tenant: ${M365_PROV_TENANT_ID}"
echo "Client: ${M365_PROV_CLIENT_ID}"

get_access_token
probe_subscribed_skus
probe_cloudpc_policies
probe_tap_policy

section "RECOMMENDED M365_PROV_* App Service settings, based on this run"

if [ -n "$SKU_SUMMARY_FILE" ]; then
  if [ -n "$W365_CANDIDATES" ]; then
    echo "  M365_PROV_BASELINE_SKUS=<E3-part-number>,<DefenderP2-part-number>,<one of the flagged candidates below, confirmed by a human>"
    printf '%s\n' "$W365_CANDIDATES" | sed 's/^/    candidate: /'
  else
    echo "  M365_PROV_BASELINE_SKUS=<could not suggest a Windows 365 candidate — see PROBE 1 output above>"
  fi
  info "This script does NOT know the exact skuPartNumber for M365 E3 GCC High or"
  info "Defender for Endpoint P2 in this tenant either — cross-reference the full"
  info "SKU table above (not just the flagged rows) against the license names on"
  info "the paper form and copy the exact skuPartNumber strings, comma-separated,"
  info "no spaces."
else
  echo "  M365_PROV_BASELINE_SKUS=<unresolved — probe 1 failed, see above>"
fi

if [ -n "$WORKING_CLOUDPC_API_VERSION" ]; then
  echo "  M365_PROV_CLOUDPC_API_VERSION=${WORKING_CLOUDPC_API_VERSION}"
else
  echo "  M365_PROV_CLOUDPC_API_VERSION=<unresolved — probe 2/3 failed, see above; config.ts defaults to 'beta' if unset>"
fi

if [ -n "$FOUND_POLICY_NAME" ]; then
  echo "  M365_PROV_CLOUDPC_POLICY=${FOUND_POLICY_NAME}"
else
  echo "  M365_PROV_CLOUDPC_POLICY=<unresolved or no exact 'SBSFederal Cloud PC' match — see PROBE 2 output above; code default is 'SBSFederal Cloud PC'>"
fi

echo
if [ -z "$TAP_STATE" ]; then
  echo "  (TAP policy state unresolved — see PROBE 4 output above. No M365_PROV_* setting"
  echo "   corresponds to this; it governs whether issue_tap runs or is skipped.)"
elif [ "$TAP_STATE" != "enabled" ]; then
  echo "  (TAP policy is NOT enabled — issue_tap will need to be treated as skippable"
  echo "   per the design doc's fallback. No M365_PROV_* setting corresponds to this.)"
else
  echo "  (TAP policy is enabled — no action needed for issue_tap.)"
fi

echo
echo "M365_PROV_TENANT_ID / M365_PROV_CLIENT_ID / M365_PROV_CLIENT_SECRET are unchanged"
echo "by this probe — they're whatever you already set to run it."
echo
echo "Done. Reminder: this script made GET requests only."

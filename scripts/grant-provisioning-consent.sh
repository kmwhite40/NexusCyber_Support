#!/usr/bin/env bash
#
# grant-provisioning-consent.sh
#
# Grants admin consent for the Anchor-Provisioning app's five application permissions.
#
# WHY THIS EXISTS: `az ad app permission admin-consent` answers
#   "This command is not yet supported on sovereign clouds"
# in Azure Government, which is where this tenant lives. The underlying operation is not
# missing, only the CLI convenience wrapper — consent for application permissions IS a set of
# appRoleAssignment rows on the app's service principal, and those can be created directly
# through Graph with `az rest`. This script does exactly that, one row per permission.
#
# ============================================================================
#  DRY RUN BY DEFAULT. Without --apply nothing is granted: it resolves the ids,
#  shows what is already consented, and prints what it would add.
#
#  Running with --apply IS granting admin consent. You need Global Administrator
#  (or Privileged Role Administrator). Five directory-write permissions become
#  live the moment it succeeds.
# ============================================================================
set -euo pipefail

APP_ID="${APP_ID:-15b6117e-9709-4d09-83f5-40e5972a6afd}"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
GRAPH_URL="${GRAPH_URL:-https://graph.microsoft.us}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

PERMS=(
  "User.ReadWrite.All"
  "Organization.Read.All"
  "Group.ReadWrite.All"
  "UserAuthenticationMethod.ReadWrite.All"
  "CloudPC.ReadWrite.All"
)

# PERMS_OVERRIDE replaces the list entirely, so this script can serve any app registration, not
# just Anchor-Provisioning — set APP_ID too. That is how a per-customer device-sync app gets its
# single DeviceManagementManagedDevices.Read.All consented, without a second near-identical
# script that would drift out of step with this one.
if [ -n "${PERMS_OVERRIDE:-}" ]; then
  PERMS=()
  for e in $PERMS_OVERRIDE; do PERMS+=("$e"); done
  echo "! PERMS_OVERRIDE in effect — granting only: $PERMS_OVERRIDE"
  echo
fi

# EXTRA_PERMS lets you consent a permission that is NOT part of the design's standing list —
# space-separated, e.g. EXTRA_PERMS="Policy.Read.All" to let probe 4 read the Temporary Access
# Pass policy. Kept separate from PERMS on purpose: the standing list is what this app is
# designed to hold, and something granted for a one-off probe should not quietly join it. If you
# grant one this way, decide afterwards whether to revoke it or add it to the design doc.
if [ -n "${EXTRA_PERMS:-}" ]; then
  for e in $EXTRA_PERMS; do PERMS+=("$e"); done
  echo "! EXTRA_PERMS requested beyond the design's standing list: $EXTRA_PERMS"
  echo
fi

az account show >/dev/null 2>&1 || { echo "✗ az not logged in" >&2; exit 1; }

SP_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"
GRAPH_SP_ID="$(az ad sp show --id "$GRAPH_APP_ID" --query id -o tsv)"
echo "App service principal  : $SP_ID"
echo "Graph service principal: $GRAPH_SP_ID"
echo

EXISTING="$(az rest --method GET --resource "$GRAPH_URL" \
  --url "$GRAPH_URL/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
  --query "value[].appRoleId" -o tsv 2>/dev/null || true)"

echo "▶ Resolving permission ids and checking what is already consented…"
TO_GRANT=()
TO_GRANT_NAME=()
for p in "${PERMS[@]}"; do
  id="$(az ad sp show --id "$GRAPH_APP_ID" \
        --query "appRoles[?value=='$p' && contains(allowedMemberTypes,'Application')].id | [0]" -o tsv)"
  if [ -n "$EXISTING" ] && echo "$EXISTING" | grep -q "$id"; then
    echo "  ✓ $p — already consented"
  else
    echo "  + $p — would grant ($id)"
    TO_GRANT+=("$id")
    TO_GRANT_NAME+=("$p")
  fi
done
echo

if [ "${#TO_GRANT[@]}" -eq 0 ]; then
  echo "✓ Nothing to do — all five are already consented."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo "── DRY RUN — nothing granted. ${#TO_GRANT[@]} permission(s) would be granted."
  echo "   Re-run as a Global Administrator with:"
  echo "     scripts/grant-provisioning-consent.sh --apply"
  exit 0
fi

echo "▶ Granting ${#TO_GRANT[@]} permission(s)…"
i=0
for id in "${TO_GRANT[@]}"; do
  name="${TO_GRANT_NAME[$i]}"
  i=$((i+1))
  body="{\"principalId\":\"$SP_ID\",\"resourceId\":\"$GRAPH_SP_ID\",\"appRoleId\":\"$id\"}"
  if az rest --method POST --resource "$GRAPH_URL" \
       --url "$GRAPH_URL/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
       --headers "Content-Type=application/json" --body "$body" -o none 2>/dev/null; then
    echo "  ✓ granted $name"
  else
    echo "  ✗ FAILED $name — you may lack Global Administrator, or a consent policy blocks it"
  fi
done

# Verify against Graph rather than trusting that the POSTs meant what they returned. A consent
# that partially applied is the dangerous state: the app authenticates, some calls work, and the
# failures look like unrelated bugs later.
echo
echo "▶ Verifying against Graph…"
FINAL="$(az rest --method GET --resource "$GRAPH_URL" \
  --url "$GRAPH_URL/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
  --query "length(value)" -o tsv 2>/dev/null || echo 0)"
echo "  $FINAL of ${#PERMS[@]} application permissions now consented."
if [ "$FINAL" -lt "${#PERMS[@]}" ]; then
  echo "  ⚠ Fewer than expected. This script is idempotent — re-run it, or grant the rest in the"
  echo "    Entra portal under App registrations > Anchor-Provisioning > API permissions."
  exit 1
fi
echo "✓ Consent complete. The read-only probes will now return real answers:"
echo "    scripts/probe-tenant-followups.sh"
echo "    scripts/probe-provisioning-tenant.sh"
echo "  (both need M365_PROV_TENANT_ID / M365_PROV_CLIENT_ID / M365_PROV_CLIENT_SECRET set)"

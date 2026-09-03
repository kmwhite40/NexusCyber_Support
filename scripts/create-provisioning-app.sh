#!/usr/bin/env bash
#
# create-provisioning-app.sh
#
# Creates the `Anchor-Provisioning` app registration described in
# docs/nexus/artifacts/deploy/anchor-provisioning-app-registration.md, which is the single
# prerequisite blocking BOTH tenant probes and account provisioning itself.
#
# ============================================================================
#  DRY RUN BY DEFAULT. Without --apply this script creates nothing: it checks
#  which tenant you are pointed at, resolves the five permission ids from that
#  tenant's own Graph service principal, and prints exactly what it would do.
#  Re-run with --apply once the tenant shown is the one you mean.
#
#  It never grants admin consent. Consent is a deliberate act by a Global
#  Administrator, and a script that silently granted five directory-write
#  permissions would be the wrong tool. The command is printed for you to run.
# ============================================================================
set -euo pipefail

APP_NAME="${APP_NAME:-Anchor-Provisioning}"
RG="${RG:-anchor-gov-rg}"
API_APP="${API_APP:-anchor-api}"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# The five APPLICATION permissions from §3 of the deploy doc. Resolved to ids from the tenant
# rather than hardcoded: near-namesakes are the documented hazard here (User.ReadWrite.All vs
# Directory.ReadWrite.All, the several UserAuthenticationMethod.* scopes), and resolving by the
# exact string is what makes "we added the right one" checkable instead of assumed.
PERMS=(
  "User.ReadWrite.All"
  "Organization.Read.All"
  "Group.ReadWrite.All"
  "UserAuthenticationMethod.ReadWrite.All"
  "CloudPC.ReadWrite.All"
)

command -v az >/dev/null || { echo "✗ az CLI not found" >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "✗ az not logged in" >&2; exit 1; }

TENANT_ID="$(az account show --query tenantId -o tsv)"
TENANT_NAME="$(az account show --query name -o tsv)"
CLOUD="$(az cloud show --query name -o tsv)"

echo "════════════════════════════════════════════════════════════════"
echo " Cloud    : $CLOUD"
echo " Tenant   : $TENANT_ID"
echo " Account  : $TENANT_NAME"
echo "════════════════════════════════════════════════════════════════"
echo
# Check the tenant against a known-good fact rather than asking a human to eyeball a GUID.
# anchor-api's M365_TENANT_ID is the directory the working mail integration authenticates
# against, so it is the tenant that demonstrably owns the mailboxes. If the az login does not
# match it, this app would be created in the wrong directory — where it would authenticate
# perfectly and see none of the users you need, which is the failure this check exists to catch.
M365_TENANT="$(az webapp config appsettings list -g "$RG" -n "$API_APP" \
  --query "[?name=='M365_TENANT_ID'].value" -o tsv 2>/dev/null || true)"
if [ -z "$M365_TENANT" ]; then
  echo "⚠  Could not read M365_TENANT_ID from $API_APP to cross-check the tenant."
  echo "   Verify by hand that $TENANT_ID is the SBS Federal GCC High directory."
elif [ "$M365_TENANT" = "$TENANT_ID" ]; then
  echo "✓ Tenant matches anchor-api's live M365_TENANT_ID — this is the directory the working"
  echo "  mail integration authenticates against, so it is the right one."
else
  echo "✗ TENANT MISMATCH — refusing to continue."
  echo "    az login tenant     : $TENANT_ID"
  echo "    anchor-api M365     : $M365_TENANT"
  echo "  Creating the app here would put it in a directory that does not own the mailboxes."
  echo "  Re-run after: az login --tenant $M365_TENANT"
  exit 1
fi
echo

echo "▶ Resolving permission ids from this tenant's Microsoft Graph service principal…"
declare -a RESOLVED=()
for p in "${PERMS[@]}"; do
  id="$(az ad sp show --id "$GRAPH_APP_ID" \
        --query "appRoles[?value=='$p' && contains(allowedMemberTypes,'Application')].id | [0]" -o tsv 2>/dev/null || true)"
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    echo "  ✗ $p — NOT FOUND as an application permission in this tenant"
    echo "     Stopping: an unavailable permission means either the wrong tenant or a"
    echo "     licensing difference, and both are things to understand before creating the app."
    exit 1
  fi
  echo "  ✓ $p = $id"
  RESOLVED+=("$id")
done
echo

if [ "$APPLY" -eq 0 ]; then
  cat <<EOF
── DRY RUN — nothing was created ──────────────────────────────────

Would create app registration : $APP_NAME
  single tenant (AzureADMyOrg), no redirect URI (client-credentials daemon app)
Would add ${#RESOLVED[@]} application permissions, listed above.
Would create one client secret and print its value once.

Re-run with --apply when the tenant above is correct:

  scripts/create-provisioning-app.sh --apply

EOF
  exit 0
fi

echo "▶ Creating app registration '$APP_NAME'…"
APP_ID="$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
echo "  appId: $APP_ID"

echo "▶ Adding application permissions…"
for id in "${RESOLVED[@]}"; do
  az ad app permission add --id "$APP_ID" --api "$GRAPH_APP_ID" --api-permissions "$id=Role" -o none 2>/dev/null
done
echo "  added ${#RESOLVED[@]}"

echo "▶ Creating a service principal for the app (required before consent)…"
az ad sp create --id "$APP_ID" -o none 2>/dev/null || echo "  (service principal already exists)"

echo "▶ Creating client secret…"
SECRET="$(az ad app credential reset --id "$APP_ID" \
  --display-name "Anchor-Provisioning — App Service — created $(date -u +%Y-%m-%d)" \
  --years 1 --query password -o tsv)"
EXPIRY="$(date -u -v+1y +%Y-%m-%d 2>/dev/null || date -u -d '+1 year' +%Y-%m-%d)"

cat <<EOF

════════════════════════════════════════════════════════════════
 CREATED. Three things remain, and none of them are automatic.
════════════════════════════════════════════════════════════════

1) GRANT ADMIN CONSENT (needs a Global Administrator):

   az ad app permission admin-consent --id $APP_ID

   Then confirm all five show "Granted for <tenant>" in the portal. Consent is
   what makes the permissions real; without it the app authenticates and every
   call returns 403.

2) RECORD THE SECRET EXPIRY: $EXPIRY
   Put it somewhere that surfaces BEFORE that date. There is no health check
   for this credential yet — an expired secret fails as silent 401s on the next
   provisioning attempt, not as an alert.

3) SET THE APP SERVICE CONFIG (leave M365_PROV_ENABLED off for now):

   az webapp config appsettings set -g $RG -n $API_APP --settings \\
     M365_PROV_TENANT_ID=$TENANT_ID \\
     M365_PROV_CLIENT_ID=$APP_ID \\
     M365_PROV_CLIENT_SECRET='$SECRET'

Then the two read-only probes can finally run:

   M365_PROV_TENANT_ID=$TENANT_ID \\
   M365_PROV_CLIENT_ID=$APP_ID \\
   M365_PROV_CLIENT_SECRET='$SECRET' \\
     scripts/probe-provisioning-tenant.sh

   (and scripts/probe-tenant-followups.sh, same three variables)

CLIENT SECRET (shown once): $SECRET

EOF

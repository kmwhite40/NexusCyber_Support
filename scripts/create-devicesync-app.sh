#!/usr/bin/env bash
#
# create-devicesync-app.sh <CustomerName>
#
# Creates the per-customer app registration the CMDB device sync uses to read ONE tenant's
# Intune managed devices, then prints the three values to paste into Nexus at /integrations.
#
# WHY ONE APP PER CUSTOMER, including for SBS itself: the sync's entire isolation story is that
# a customer's devices are reachable only with that customer's own credentials — the separation
# is enforced by what the token can see, not by the code remembering to filter. Reusing
# Anchor-Provisioning here would be convenient and would be the first hole in that. SBS is a
# customer of its own platform like any other, so it gets its own app.
#
# This grants exactly one permission: DeviceManagementManagedDevices.Read.All. The sync only
# ever reads; nothing in the product writes to a customer tenant through this credential.
#
# ============================================================================
#  DRY RUN BY DEFAULT. Without --apply nothing is created.
#  Consent is a SEPARATE step, deliberately — see the end of the output.
# ============================================================================
set -euo pipefail

# Absolute, so the follow-up command printed at the end works from any working directory —
# the relative form failed for a real operator whose shell starts elsewhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CUSTOMER="${1:-}"
if [ "$CUSTOMER" = "--apply" ] || [ -z "$CUSTOMER" ]; then
  echo "usage: $0 <CustomerName> [--apply]" >&2
  echo "   e.g: $0 SBS            # dry run" >&2
  echo "        $0 SBS --apply" >&2
  exit 1
fi
APPLY=0
[ "${2:-}" = "--apply" ] && APPLY=1

APP_NAME="Anchor-DeviceSync-${CUSTOMER}"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
PERM="DeviceManagementManagedDevices.Read.All"

az account show >/dev/null 2>&1 || { echo "✗ az not logged in" >&2; exit 1; }
TENANT_ID="$(az account show --query tenantId -o tsv)"

echo "════════════════════════════════════════════════════════════════"
echo " App      : $APP_NAME"
echo " Tenant   : $TENANT_ID"
echo " Cloud    : $(az cloud show --query name -o tsv)"
echo "════════════════════════════════════════════════════════════════"
echo
echo "⚠  This must be the CUSTOMER'S tenant — the directory whose devices you want in the CMDB."
echo "   For a customer other than SBS that means: az login --tenant <their tenant id>, with an"
echo "   account that can register applications there. Creating it in the wrong directory yields"
echo "   an app that authenticates and enumerates nothing, which the sync reports as an empty"
echo "   tenant rather than as an error."
echo

PERM_ID="$(az ad sp show --id "$GRAPH_APP_ID" \
  --query "appRoles[?value=='$PERM' && contains(allowedMemberTypes,'Application')].id | [0]" -o tsv 2>/dev/null || true)"
if [ -z "$PERM_ID" ] || [ "$PERM_ID" = "None" ]; then
  echo "✗ $PERM is not available as an application permission in this tenant."
  echo "  That usually means no Intune/Endpoint Manager licensing here — worth knowing BEFORE"
  echo "  creating an app that could never return a device."
  exit 1
fi
echo "✓ $PERM = $PERM_ID"
echo

if [ "$APPLY" -eq 0 ]; then
  echo "── DRY RUN — nothing created ──────────────────────────────────"
  echo "   Would create '$APP_NAME' (single tenant, no redirect URI) with that one permission."
  echo "   Re-run with:  $0 $CUSTOMER --apply"
  exit 0
fi

echo "▶ Creating app registration '$APP_NAME'…"
APP_ID="$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
echo "  appId: $APP_ID"

az ad app permission add --id "$APP_ID" --api "$GRAPH_APP_ID" --api-permissions "$PERM_ID=Role" -o none 2>/dev/null
echo "  permission added"

az ad sp create --id "$APP_ID" -o none 2>/dev/null || echo "  (service principal already exists)"

SECRET="$(az ad app credential reset --id "$APP_ID" \
  --display-name "$APP_NAME — Nexus device sync — created $(date -u +%Y-%m-%d)" \
  --years 1 --query password -o tsv)"
EXPIRY="$(date -u -v+1y +%Y-%m-%d 2>/dev/null || date -u -d '+1 year' +%Y-%m-%d)"

cat <<EOF

════════════════════════════════════════════════════════════════
 CREATED — two steps remain.
════════════════════════════════════════════════════════════════

1) GRANT ADMIN CONSENT (Global Administrator in THIS tenant).
   \`az ad app permission admin-consent\` does not work on sovereign clouds, so:

   APP_ID=$APP_ID PERMS_OVERRIDE="$PERM" \\
     $SCRIPT_DIR/grant-provisioning-consent.sh --apply

   Until this is done the app authenticates fine and every device call returns 403.

2) ADD THE CUSTOMER IN NEXUS at /integrations (needs integration.credentials.manage):

   Directory (tenant) ID : $TENANT_ID
   Application (client) ID: $APP_ID
   Client secret          : $SECRET

   Then: Save credentials -> Test connection -> Enable -> Sync now.

SECRET EXPIRES: $EXPIRY
There is no expiry alert. When it lapses the sync fails and the run history records
the error, but nothing tells you proactively — put the date somewhere that will.
EOF

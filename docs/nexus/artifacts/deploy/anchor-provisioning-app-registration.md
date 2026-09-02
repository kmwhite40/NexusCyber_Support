# Setting up the `Anchor-Provisioning` app registration (SBS Federal GCC High tenant)

For whoever administers the SBS Federal Entra tenant. Creates the app registration the
onboarding-provisioning engine uses to create Entra accounts, assign licenses, add group
memberships, issue a Temporary Access Pass, and drive Windows 365 Cloud PC provisioning. See
`docs/superpowers/specs/2026-09-01-sbs-user-onboarding-provisioning-design.md` for the full
design this supports; this document is the tenant-side setup steps only.

**This app is not built or wired into Anchor yet at the time of writing** — this is a
prerequisite you can complete independently of the code work, so the engine has something to
authenticate as once it ships. `M365_PROV_ENABLED` stays `false` (the feature's default) until
both sides are ready.

## 1. Why a separate app, not a scope added to `Anchor-Authentication`

Anchor already has an app registration, `Anchor-Authentication`, that holds `Mail.Send` /
`Mail.Read` for the M365 mail integration (see the `m365-mail-prod-config` memory / the mail
notification design docs). **Do not add provisioning scopes to that app.** Two independent
reasons, both from the design doc:

1. **Different blast radius.** `Anchor-Authentication` backs a long-running, internet-reachable
   ingest poller (it polls a shared mailbox continuously). If that poller's process or its
   credential were ever compromised, an app holding only mail scopes limits the damage to mail.
   The provisioning app needs `User.ReadWrite.All` and `UserAuthenticationMethod.ReadWrite.All`
   — directory-write and the ability to touch how any user authenticates. Combining the two
   would mean a compromise of the (more exposed) mail path becomes a compromise of the identity
   plane.
2. **Two secrets, two rotation schedules, two audit trails.** Keeping them separate means a
   secret rotation or an incident response on one never has to touch the other, and sign-in /
   audit logs for "who provisioned this account" are never mixed with "who sent this mail."

**After this app exists, confirm `Anchor-Authentication` still holds only its mail scopes** —
`Mail.Send` and `Mail.Read` (application permissions) and nothing else. If it has accumulated
other scopes over time, that's worth cleaning up as part of this work, not silently living with.

## 2. Create the app registration

In the SBS Federal tenant's Entra admin center (GCC High — confirm you're in the `.us` admin
portal, not the commercial one):

1. **Entra ID > App registrations > New registration.**
2. Name: **`Anchor-Provisioning`**.
3. Supported account types: **Accounts in this organizational directory only** (single tenant —
   this app only ever needs to act against the SBS Federal tenant itself; it is not a
   multi-tenant integration).
4. No redirect URI needed — this is a daemon/service application using the client-credentials
   flow (`app-only` / application permissions), not a user sign-in flow.
5. Register. Record the **Application (client) ID** and the **Directory (tenant) ID** shown on
   the overview page — both go into App Service config in §5.

## 3. Application permissions

Add these as **Application permissions** (not Delegated — this app has no signed-in user; it
authenticates as itself via client-credentials grant), under **API permissions > Add a
permission > Microsoft Graph > Application permissions**. This list is copied verbatim from the
design doc's permission table — do not substitute similarly-named permissions without checking
the doc first, since several Graph permissions have easily-confused near-namesakes (e.g.
`User.ReadWrite.All` vs `Directory.ReadWrite.All`, or the several different
`UserAuthenticationMethod.*` scopes).

| Permission | What it's for |
|---|---|
| `User.ReadWrite.All` | Create the Entra account for the new hire (`POST /users`), and read it back to check for an existing UPN on retry. |
| `Organization.Read.All` | Read `/subscribedSkus` — resolves the configured baseline SKU part numbers to real `skuId`s and remaining seat counts, so "no seats left" surfaces in the provisioning preview instead of failing mid-run. |
| `Group.ReadWrite.All` | Add the new user to security/distribution groups from the form, and to the group backing the `SBSFederal Cloud PC` provisioning policy (Cloud PC materializes only when a licensed user lands in that policy's assigned group). |
| `UserAuthenticationMethod.ReadWrite.All` | Issue a Temporary Access Pass to the new user's authentication methods, delivered to the supervisor for first sign-in. |
| `CloudPC.ReadWrite.All` | Read Cloud PC provisioning policies (`/deviceManagement/virtualEndpoint/provisioningPolicies`) and poll Cloud PC build status (`/deviceManagement/virtualEndpoint/cloudPCs`). |

**`UserAuthenticationMethod.ReadWrite.All` is the sharpest permission on this list** — the design
doc calls this out explicitly. It can reset authentication methods on *any* account in the
tenant, not just ones this app creates. Nothing about the design or this permission set
technically prevents the app from being used (by a compromised secret, or a bug) to strip or
replace an existing employee's — including an administrator's — authentication methods. The
application-layer guards in the provisioning engine (UPN domain allow-list, refusal to touch an
account holding a directory role) are what actually bound this in practice; the Graph permission
grant itself is tenant-wide. See §6 for the administrative-unit option that would narrow this at
the Graph layer instead of only in application code.

**Not requested here, but you may separately need for tenant reconnaissance:** if you use
`scripts/probe-provisioning-tenant.sh` (a read-only script that answers some of this design's
open tenant questions) to check whether the Temporary Access Pass authentication method is
enabled tenant-wide, that probe reads `/policies/authenticationMethodsPolicy`, which needs
`Policy.Read.All` — a permission **not** in the table above and not needed by the provisioning
engine itself at runtime. Grant it only temporarily to a probe credential if you use that script,
not to the production `Anchor-Provisioning` app permanently, unless you have a separate reason to
want it there.

## 4. Grant admin consent

Application permissions of this shape do nothing until a tenant admin explicitly consents —
until then, every Graph call this app makes fails with a 403 regardless of the permissions listed
on the app.

1. On the app's **API permissions** page, click **Grant admin consent for [tenant]**.
2. Confirm the consent dialog lists exactly the five permissions in §3 — if anything else
   appears (a permission added by mistake, or a stale one from testing), remove it before
   consenting, not after; consent is per-permission-set and you don't want to have granted a
   scope you then have to explain revoking.
3. This step requires **Global Administrator** or **Privileged Role Administrator** in the
   tenant (a Cloud Application Administrator with sufficient scope may also be able to, depending
   on the tenant's role assignment — if the button is greyed out, you don't have the right role).
4. After consent, the **Status** column for each permission on that page should read **Granted
   for [tenant]** with a green check. Screenshot or note the date — this is worth having on hand
   if the tenant is ever audited for what has directory-write access and why.

## 5. Generate the client secret and where it goes

1. **Certificates & secrets > Client secrets > New client secret.**
2. Description: something identifying ("Anchor-Provisioning — App Service — created
   YYYY-MM-DD") so a future reader doesn't have to guess what it's for from the value alone.
3. **Expiry: pick the shortest option your process can actually keep up with, and record the
   exact expiry date somewhere outside the Entra portal** (a ticket, a calendar reminder, this
   doc's revision history — anywhere that will surface *before* the secret dies, not after). This
   integration has no mail-integration-style health check yet to surface expiry visibly the way
   `06-notifications-m365.md` describes for the mail app — until the provisioning engine ships
   its own equivalent, an expired secret here fails silently as 401s on the next provisioning
   attempt, not as a proactive alert. Treat the calendar reminder as load-bearing, not optional.
4. Copy the secret **value** (not the Secret ID) immediately — Entra shows it exactly once.
5. **Where it goes: App Service application settings on `anchor-api`, not Key Vault.** This
   matches the existing pattern for every other secret in this deployment (`DATABASE_URL`,
   `APP_DATABASE_URL`, `SESSION_SIGNING_KEY`, the `Anchor-Authentication` mail credentials) —
   see the `azure-gov-deployment` memory: a NIST SP 800-53 Azure Policy in this gov subscription
   **denies Key Vault** without purge-protection plus a locked-down firewall, and a locked-down
   Key Vault can't serve App Service Key Vault references without VNet + Private Endpoint, which
   this environment doesn't have. So the residual trust boundary here is genuinely "encrypted App
   Service app settings," not "Key Vault reference" — that's a known, accepted gap in this
   enclave (see the device-sync spec's same note), not an oversight specific to this app.
   Set (via `az webapp config appsettings set -g anchor-gov-rg -n anchor-api --settings ...`, or
   the portal's Configuration blade):
   - `M365_PROV_TENANT_ID` = the Directory (tenant) ID from §2
   - `M365_PROV_CLIENT_ID` = the Application (client) ID from §2
   - `M365_PROV_CLIENT_SECRET` = the secret value from this step
   - Leave `M365_PROV_ENABLED` unset (or `false`) until the provisioning engine code is deployed
     and you've completed the tenant-fact probes in the design doc's "Open items" section — this
     setting is the master switch, and `parseProvisioningConfig` (`apps/api/src/config.ts`) keeps
     the feature dark if the required fields aren't all present, so an incomplete rollout here
     fails closed rather than half-provisioning a user.

## 6. Administrative-unit scoping — the open trade-off

The design doc leaves this open (its "Open item #2") and recommends resolving it against how
SBS's Entra structure is actually laid out, which is tenant-specific knowledge this document
doesn't have. The question and its trade-off, so whoever makes the call has both sides:

- **Option A — leave the permissions tenant-wide (the default above).** Simpler to set up, no
  dependency on how administrative units are organized. The cost is that
  `UserAuthenticationMethod.ReadWrite.All` and `User.ReadWrite.All` are tenant-wide grants, so a
  compromised secret or a bug in principle reaches every account, not just new-hire accounts. The
  design's compensating controls (UPN domain allow-list refusing any UPN outside the configured
  domain; refusal to adopt/modify an existing account that holds any directory role) reduce the
  *practical* blast radius substantially, but they're application-layer checks, not a Graph-level
  restriction — a bug in that application code is what stands between "tenant-wide grant" and
  "tenant-wide access."
- **Option B — scope the app's permissions to an administrative unit (AU) containing only
  new-hire objects.** Restricting an app registration's effective permissions to an AU is a real
  Entra ID Governance capability (restricted management administrative units / scoped app role
  assignments), but the exact mechanism and which of the five permissions in §3 can be
  AU-scoped this way is **not verified in this repo against SBS's tenant** — this document is not
  the place to assert Graph/Entra governance mechanics that haven't been checked against the live
  tenant. If you pursue this option, confirm directly in the Entra admin center (or with
  Microsoft's current Entra ID Governance documentation) which permissions actually honor AU
  scoping for an application (as opposed to a user), and whether SBS's Entra ID edition/licensing
  includes the AU-restricted-management feature at all before assuming it's available. The
  practical prerequisite either way is that new-hire objects need to land in a dedicated AU
  automatically or by convention — if new-hire provisioning doesn't already place users into a
  distinct AU, this option requires establishing that convention first, which is itself tenant
  design work, not app-registration configuration.

**Fallback if Option B doesn't pan out or isn't pursued now:** ship with Option A (tenant-wide)
and rely on the UPN allow-list + privileged-account refusal as the compensating controls, exactly
as the design doc's fallback says. That is a legitimate, deliberate choice, not a placeholder —
just make sure whoever owns tenant security risk has actually seen and accepted this trade-off,
rather than it being implicit in "well, that's what the default did."

## 7. Checklist

- [ ] `Anchor-Provisioning` app registered, single-tenant, in the SBS Federal (GCC High) tenant
- [ ] Confirmed `Anchor-Authentication` still holds only `Mail.Send` / `Mail.Read`
- [ ] Exactly the 5 permissions in §3 added as **Application** permissions
- [ ] Admin consent granted; all 5 show "Granted for [tenant]"
- [ ] Client secret generated, value captured once, expiry date recorded outside the portal
- [ ] `M365_PROV_TENANT_ID` / `M365_PROV_CLIENT_ID` / `M365_PROV_CLIENT_SECRET` set on
      `anchor-api` App Service config (not Key Vault)
- [ ] `M365_PROV_ENABLED` deliberately left off until the provisioning engine ships and the
      tenant-fact open items are resolved
- [ ] Administrative-unit scoping decision (§6) made deliberately, not left implicit

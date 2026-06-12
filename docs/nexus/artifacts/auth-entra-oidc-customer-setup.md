# Configure customer access from external M365 tenants (multi-tenant Entra OIDC)

Step-by-step to let **customer organizations** sign in to Anchor with **their own** Entra ID
(Azure Government). This is the Phase 2 model from [auth-entra-oidc-scope.md](./auth-entra-oidc-scope.md).

> **Read this first — two prerequisites:**
> 1. **Cloud match.** Anchor runs in **Azure Government** (`login.microsoftonline.us`). Only
>    customers whose M365 is **also in GCC High / Azure Gov (.us)** can use this. Commercial
>    (`login.microsoftonline.com`) customers cannot authenticate to a gov app — they need a
>    separate commercial deployment, or B2B guest invites (see §7).
> 2. **Code support — now shipped (disabled by default).** The Phase 2 multitenant code in §5
>    is implemented (`OIDC_CUSTOMER_*`, migration 0027, per-tenant JWKS + `tid` allow-list,
>    `loginOrProvisionCustomerOidc`, `?mode=customer`). It is **off** until you set the
>    `OIDC_CUSTOMER_*` settings and onboard at least one tenant (§4). It must be **deployed**
>    (rebuild API image + run migration 0027) before turning on.

---

## 1. Create a dedicated multi-tenant app registration
Use a **separate** registration from the agent app (`e7072737-…`) — different audience,
different lifecycle.

**Entra admin center (gov) → App registrations → New registration:**
- **Name:** `Anchor Customer SSO`
- **Supported account types:** **"Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant)"**
  - (this sets the manifest `signInAudience` to `AzureADMultipleOrgs`)
- **Redirect URI (Web):** `https://anchor-api.azurewebsites.us/api/v1/auth/oidc/callback`
- Register. Note the **Application (client) ID** → call it `<CUSTOMER_APP_CLIENT_ID>`.

**Certificates & secrets → New client secret** → copy the **Value** → `<CUSTOMER_APP_SECRET>`.

**API permissions:** Microsoft Graph → Delegated → `openid`, `profile`, `email` (no admin
consent needed in your home tenant for these; customer tenants consent in §3).

**Token configuration (recommended):** add the **`email`** optional claim, and ensure the
tenant id (`tid`) is in the token (it is by default in v2.0 id_tokens).

> You do **not** define app roles here (those were for agents). Customer authorization comes
> from their mapped org + Anchor roles, not Entra app roles.

---

## 2. Authorize via the multitenant endpoint
The app must send users to the **`/organizations`** endpoint, not a fixed tenant:
```
https://login.microsoftonline.us/organizations/oauth2/v2.0/authorize
```
(The Phase 1 single-tenant code uses `/{tenant}/`. The §5 code change switches the customer
flow to `/organizations`.)

---

## 3. Onboard each customer tenant (admin consent — the gate)
A customer's users **cannot** sign in until **their** Global Admin consents once. Send the
customer admin this URL (fill in your client id and a return URL):
```
https://login.microsoftonline.us/organizations/v2.0/adminconsent
  ?client_id=<CUSTOMER_APP_CLIENT_ID>
  &scope=openid%20profile%20email
  &redirect_uri=https://anchor.azurewebsites.us/auth/consent-complete
```
When they approve, Entra provisions an **Anchor Customer SSO** service principal in **their**
directory (visible under *Enterprise applications*). That is the on-switch. Revoking that
enterprise app (or removing the tenant from your allow-list, §4) turns them off.

> Capture the customer's **tenant ID** during onboarding — you need it for §4. The
> `admin_consent=True&tenant=<tid>` return params give it to you, or ask the customer.

---

## 4. Map the customer tenant → an Anchor org (allow-list)
This is the **critical security control**: only tenants you've onboarded may sign in.

Add a per-org tenant id and gate on it. Minimal schema (Phase 2 migration):
```sql
ALTER TABLE organizations ADD COLUMN entra_tenant_id uuid;       -- the customer's tid
CREATE UNIQUE INDEX organizations_entra_tenant_id_key
  ON organizations (entra_tenant_id) WHERE entra_tenant_id IS NOT NULL;
```
Onboard a customer org by setting its `entra_tenant_id` to the tenant id from §3. The callback
then: validate the token's `tid` exists in `organizations.entra_tenant_id`; if not → reject.
(Alternatively reuse the existing `organization_domains` verified-domain table and map by the
email domain — but `tid` is the stronger key.)

---

## 5. Code (Phase 2 — implemented, disabled by default)
Shipped on `feat/nexus-platform`; mirrors the Phase 1 OIDC code with a multitenant mode:
- **`auth/oidc.ts`** — customer variant:
  - Authorize against `…/organizations/oauth2/v2.0/authorize`.
  - On callback, read `tid` from the validated token; build/cache a JWKS **per tenant**
    (`https://login.microsoftonline.us/{tid}/v2.0` discovery) and verify the signature there.
  - Accept issuer `https://login.microsoftonline.us/{tid}/v2.0`; keep `aud=<CUSTOMER_APP_CLIENT_ID>`,
    `nonce`, `exp`. **Reject any `tid` not in the allow-list.**
- **`accounts.loginOrProvisionCustomerOidc()`** — resolve `tid` → `organizations.entra_tenant_id`
  → `organization_id`; JIT-provision the user into that org with `plane:'customer'`
  (default role `EndUser`; first user `OrgAdmin`); issue the session. RLS/ABAC then scope them.
- **Routes:** `/auth/oidc/start?mode=customer` and a shared callback that branches on a signed
  state flag (agent vs customer) to pick the right validator + mapping.
- **Web:** a "Sign in with your organization" button on the customer login path.

---

## 6. App settings (on `anchor-api`)
```
OIDC_CUSTOMER_ENABLED=true
OIDC_CUSTOMER_CLIENT_ID=<CUSTOMER_APP_CLIENT_ID>
OIDC_CUSTOMER_CLIENT_SECRET=<CUSTOMER_APP_SECRET>
OIDC_CUSTOMER_AUTHORITY=https://login.microsoftonline.us/organizations/v2.0
# Allow-list is data-driven from organizations.entra_tenant_id (preferred) — no env list.
```
Redirect/post-login URIs are the same callback + `https://anchor.azurewebsites.us/auth/callback`.

---

## 7. Simpler alternative — B2B guest invites (no Phase 2 code)
For just a handful of customer admins, skip multitenant entirely: **invite them as guests**
into the Anchor gov tenant (Entra → Users → Invite external user, or Identity Governance →
Entitlement management). They then sign in through the **Phase 1 single-tenant** app you
already have live. Trade-offs: guest objects live in your directory; you manage invitations
and lifecycle. Same gov-cloud limitation applies (guest must be a gov-cloud identity).

---

## 8. Test
1. Set the customer's `entra_tenant_id` (§4) and have their admin consent (§3).
2. From a browser signed into the **customer** tenant, hit the customer sign-in → consent (first
   time) → land back authenticated; `/me` should show `plane:'customer'` and their org id.
3. Negative test: a user from a **non-onboarded** tenant must be **rejected** at the callback
   (proves the `tid` allow-list works).

---

## Summary of who does what
| Step | Who |
|---|---|
| Create multitenant app registration (§1) | Anchor gov tenant admin |
| Implement Phase 2 code (§5) + migration (§4) | Engineering |
| Per-customer admin consent (§3) | **Each customer's** Global Admin |
| Set `entra_tenant_id` to onboard an org (§4) | Anchor operator |
| Cloud match (gov-to-gov) | Hard prerequisite — not configurable |

# Scope: Entra ID (Azure Gov) OIDC for the Anchor agent plane

> **Status (Phase 1 implemented, disabled by default).** The full flow is built and
> typechecks/builds green: `apps/api/src/auth/oidc.ts` (discovery, PKCE, code exchange,
> id_token validation via `jose`), `accounts.loginOrProvisionAgentOidc` (JIT map app
> roles → nexus user), routes `/auth/config`, `/auth/oidc/start`, `/auth/oidc/callback`,
> migration `0026_oidc_external_id.sql`, and the web login button + `/auth/callback` page.
> Gated by `OIDC_ENABLED` (default **false**) — inert until an Entra **app registration**
> exists and the `OIDC_*` app settings are filled (see "Go-live" at the bottom).

**Goal:** Let Anchor **agents** (nexus plane) sign in with their organization's Entra ID
in Azure Government — replacing the interim shared scrypt passwords — without changing
the authorization model. Customers keep local register/login (a later phase can federate
per-customer IdPs).

## Design principle — OIDC is just a new *login method*

Today every session is a local HS256 JWT (`SessionClaims {sub, plane, email, org, roles}`)
minted by `issueSession()` ([apps/api/src/auth/session.ts](../../../apps/api/src/auth/session.ts))
and resolved by `loadPrincipal()` ([apps/api/src/auth/principal.ts](../../../apps/api/src/auth/principal.ts)).
RBAC/ABAC (the PDP) and Postgres RLS read only that principal. So OIDC adds a new
front door that, after validating the Entra token, **maps the Entra identity to a nexus
user row and calls the existing `issueSession()`**. Everything downstream is unchanged.

```
Browser ──/auth/oidc/start──▶ API ──302──▶ login.microsoftonline.us/{tenant}/oauth2/v2.0/authorize (PKCE)
                                                   │  (user authenticates w/ Entra + MFA)
Browser ◀──302 /auth/oidc/callback?code&state──────┘
Browser ──/auth/oidc/callback──▶ API: exchange code→tokens, validate id_token, map→user,
                                  issueSession() → set HttpOnly session cookie ─▶ app
```

## Azure Government specifics (NOT the commercial endpoints)

- Authority: `https://login.microsoftonline.us/{tenantId}/v2.0`
- Authorize / token: `…/oauth2/v2.0/authorize`, `…/oauth2/v2.0/token`
- JWKS / issuer come from the gov OIDC discovery doc:
  `https://login.microsoftonline.us/{tenantId}/v2.0/.well-known/openid-configuration`
- Graph (if used for group/role claims) is `https://graph.microsoft.us` (gcchigh) — but
  prefer **app-role assignments in the token** over Graph calls.

Reuse the existing `M365_TENANT_ID` / `M365_CLIENT_ID` config or add dedicated
`OIDC_AGENT_*` settings (recommended — keep mail and auth registrations separate).

## Work breakdown

### 1. App registration (Entra Gov) — ops, ~0.5 day
- New app registration in the gov tenant; redirect URI `https://anchor-api.azurewebsites.us/api/v1/auth/oidc/callback`.
- Client secret **or** (preferred) a certificate / workload identity. Store as an App
  Service setting (or the hardened KV+private-endpoint once that lands).
- Define **app roles** (e.g. `Anchor.Tier1`, `Anchor.Tier2`, `Anchor.ServiceDeskManager`,
  `Anchor.SecurityAnalyst`) and assign agents to them in Enterprise Applications, so role
  comes from the token, not a manual DB mapping.

### 2. API — new auth methods, ~2–3 days
- Add deps: `openid-client` (handles discovery, PKCE, code exchange, id_token validation
  incl. issuer/audience/nonce) and `jose` (JWKS). Both pure-JS, no native deps — fine for
  the gov container.
- New file `apps/api/src/auth/oidc.ts`: lazy discovery against the gov authority, build the
  client from config, helpers `buildAuthUrl(state, nonce, pkce)` and `handleCallback(params)`.
- New routes in [routes.ts](../../../apps/api/src/http/routes.ts):
  - `GET /api/v1/auth/oidc/start` → 302 to Entra (store `state`/`nonce`/PKCE verifier in a
    short-lived signed, HttpOnly cookie).
  - `GET /api/v1/auth/oidc/callback` → validate, **JIT-provision/match** the agent user,
    `issueSession()`, set the session cookie, redirect to the web app.
- **User mapping / JIT provisioning**: match on Entra `oid` (store as `users.external_id`,
  new nullable column + unique index) falling back to verified `email`. If the user is in
  an `Anchor.*` app role but has no row, create a nexus-plane user and assign the mapped
  role. Add a config allow-list of which app roles may self-provision.
- **Token validation hardening** (the session.ts comments already call for this): pin
  `iss` to the gov tenant, `aud` to our client id, verify signature via JWKS, check `nonce`,
  reject expired/`nbf`. Reject tokens from other tenants.
- Keep local `/auth/login` for customers; gate agent local-password login off once OIDC is
  live (or leave as documented break-glass with a strong rotated password).

### 3. Web — login affordance, ~0.5 day
- On [apps/web/app/login/page.tsx](../../../apps/web/app/login/page.tsx) add a
  **"Sign in with Microsoft (Gov)"** button → `GET {API}/auth/oidc/start`.
- Handle the post-callback redirect (session is a cookie; the SPA just lands on the app).
- Customer signup/login pages unchanged.

### 4. Config / infra — ~0.25 day
- App settings: `OIDC_ENABLED=true`, `OIDC_AUTHORITY`, `OIDC_TENANT_ID`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET` (or cert), `OIDC_REDIRECT_URI`, `OIDC_ALLOWED_APP_ROLES`.
- Add them to [webapp-gov-api.bicep](../../../infra/azure/webapp-gov-api.bicep) (and ideally
  move the secret to the hardened KV when that lands).
- Migration: `ALTER TABLE users ADD COLUMN external_id text` + partial unique index.

### 5. Tests / verify — ~0.5 day
- Unit: token-validation rejects wrong `iss`/`aud`/expired/replayed `nonce`.
- E2E against the gov tenant: agent with `Anchor.SecurityAnalyst` → `/me` shows
  plane=nexus + SecurityAnalyst, `/conmon/runs` 200; agent with no app role → denied.

## Estimate
~**4–6 engineering days** + the Entra app registration (ops). Phaseable: ship agent OIDC
first (highest value — removes the shared agent password), defer per-customer customer-IdP
federation to a later phase.

## Go-live checklist (what's left — mostly Entra ops)

1. **Create the Entra app registration** in the gov tenant:
   - Redirect URI (Web): `https://anchor-api.azurewebsites.us/api/v1/auth/oidc/callback`
   - A client secret (or cert). Define **app roles** `Anchor.Tier1/Tier2/ServiceDeskManager/SecurityAnalyst`
     and assign agents (Enterprise applications → Users and groups).
2. **Set app settings** on `anchor-api` (or pass the bicep params): `OIDC_ENABLED=true`,
   `OIDC_TENANT_ID`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_APP_ROLES`
   (e.g. `Anchor.Tier2,Anchor.SecurityAnalyst`). `OIDC_REDIRECT_URI` /
   `OIDC_POST_LOGIN_REDIRECT` are defaulted by the bicep.
3. **Deploy the new code**: rebuild the API image (`az acr build`) and run migration
   0026 (adds `users.external_id`) — same one-off ACI path as the initial deploy.
4. The login page's **"Sign in with Microsoft (Gov)"** button appears automatically once
   `/auth/config` reports `oidcEnabled:true`.

## Phase 2 — Customer access from external M365 tenants (multi-tenant)

Phase 1 is **single-tenant** (agents in the Anchor gov tenant). To let *customer*
organizations sign in with **their own** Entra ID, the app must accept tokens from many
issuers. This is a distinct mode, not a config tweak.

### The model: one multi-tenant app + a tenant allow-list → org mapping
1. **Mark the app registration multi-tenant** ("Accounts in any organizational directory").
   Authorize against the multi-tenant endpoint, not a fixed tenant:
   `https://login.microsoftonline.us/organizations/oauth2/v2.0/authorize`.
2. **Per-customer admin consent (onboarding gate).** Each customer tenant admin hits
   `https://login.microsoftonline.us/organizations/v2.0/adminconsent?client_id=<app>&scope=openid profile email&redirect_uri=<consent-return>`
   once. That provisions Anchor's service principal in *their* directory. No consent → their
   users can't sign in. This is the onboarding switch.
3. **Token validation changes (the critical security control).** You can no longer pin one
   issuer. Per token:
   - Read `tid` (tenant id); accept only if `tid ∈ allow-list` of onboarded customers.
   - Validate signature against **that tenant's** JWKS and accept issuer
     `https://login.microsoftonline.us/{tid}/v2.0`; keep `aud = clientId`, nonce, exp.
   - **Without the `tid` allow-list, any tenant in the cloud could authenticate.** Mandatory.
4. **Tenant → Anchor org mapping.** Add `organization_tenants(tid uuid → organization_id)`
   (or reuse the verified-domain table `organization_domains` the mail ingest already uses,
   apps/api/src/integrations/m365/ingest.ts). Resolve `tid`/email-domain → `organization_id`,
   issue a session with **`plane: 'customer'`**, and existing RLS/ABAC scope the user to
   their org automatically.

### Code changes (parallel to Phase 1)
- `auth/oidc.ts`: a multi-tenant variant — `/organizations` authority, per-tenant JWKS
  (`createRemoteJWKSet` per `tid`, cached), validate `tid` against the allow-list, accept the
  per-tenant issuer.
- `accounts.loginOrProvisionCustomerOidc()`: map `tid`/domain → org, `plane: 'customer'`,
  JIT-provision the user into that org (default role `EndUser`, or `OrgAdmin` for the first
  admin). Mirrors `loginOrProvisionAgentOidc`.
- Config: `OIDC_CUSTOMER_ENABLED`, allow-list driven from the `organizations` table (a
  `entra_tenant_id` column per onboarded org) rather than a static env list.
- Web: a "Sign in with your organization" button (customer login) → same `/auth/oidc/start`
  with a `mode=customer` hint.

### ⚠️ Cloud-isolation constraint (decides who can even use this)
Microsoft clouds are isolated. Anchor runs in **Azure Government** (`login.microsoftonline.us`):
- Customer M365 **also in GCC High / Azure Gov (.us)** → ✅ works with the model above.
- Customer M365 in **commercial** (`login.microsoftonline.com`) → ❌ cannot authenticate to a
  gov app. Would need a separate commercial app registration/deployment. "Any M365 tenant"
  means "any tenant **in the same Microsoft cloud as Anchor**."

### Simpler alternative: B2B guest invite
Invite customer admins as **B2B guests** into the Anchor gov tenant (Entra External ID); they
then use the **Phase 1 single-tenant** app — no per-tenant consent, no `tid` allow-list.
Trade-off: guest objects in your directory + invitation management. Good for a few customer
admins; multi-tenant scales better for many self-serving customer orgs. Same-cloud limit still
applies.

### Estimate
~**3–5 engineering days** on top of Phase 1 (most of the OIDC plumbing is reused; the new work
is multi-issuer validation, the tenant→org allow-list/mapping, and the admin-consent onboarding
flow).

## Dependencies / risks
- Gov tenant admin must create the app registration, define app roles, and assign agents.
- Phase 2: each **customer** tenant admin must grant admin consent; customers must be in the
  same Microsoft cloud (gov) as Anchor.
- Basic-auth-disabled / NIST policy posture is unaffected (OIDC adds no inbound creds).
- Pairs naturally with the **KV + private-endpoint** hardening already flagged
  (see [[azure-gov-deployment]] / deploy docs) so the client secret/cert lives in KV.

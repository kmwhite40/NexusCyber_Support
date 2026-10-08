# ES-05 — Security & Tenant Isolation Standards

| | |
|---|---|
| **Applies to** | All code and infrastructure |
| **Status** | Active |
| **Last reviewed** | 2026-10-08 |

Anchor runs in **Azure Government** and holds customer ticket data, onboarding PII and Microsoft 365 administrative credentials. These rules are not optional.

## 1. Tenant isolation — belt and suspenders

1. **Postgres RLS** on every tenant table, keyed on `app.org_id` (ES-04).
2. **Application org-guard** in addition — never rely on RLS alone, never rely on the app check alone.
3. Cross-org access exists only for the nexus plane via `app.assigned_orgs`, and for `admin.superuser` (platform SuperAdmins). Both are audited.

## 2. Identity

- Two identity planes: **nexus** (SBS operators) and **customer** (end users/org admins). A principal belongs to exactly one plane per session.
- Production auth: Entra ID OIDC (agent plane and customer SSO) or scrypt password login. `dev-login` is hard-disabled when `NODE_ENV=production`.
- Passwords are stored only as Node `scrypt` hashes (`scrypt$salt$hash`, `auth/password.ts`).
- Machine-to-machine access uses **API keys** (`ak_<keyId>_<secret>`), stored as scrypt hashes, scoped to **one organization** and to the ticket verbs in `ALLOWED_KEY_SCOPES` only. Keys are integration identities, never admins.

## 3. Authorization

- Every route calls the **PDP** (`authz/pdp.ts`): RBAC + ABAC, **deny by default**.
- New capability → new permission verb (`noun.verb[.scope]`, e.g. `ticket.read.organization`, `pii.view`) granted by migration, never by code defaults.
- Sensitive actions (elevation, PII reads, provisioning execute) require explicit verbs and are audited per use.

## 4. Sensitive data

- Onboarding PII lives in the **PII vault**, not in `tickets.custom_fields`. Reads require `pii.view`, are audited per read, and the data is purged when the ticket closes.
- Form fields flagged sensitive are never copied into the Entra GAL, notification bodies or logs.
- HTML-escape all user-supplied content rendered into email, Teams or KB snippets.

## 5. Secrets

- Secrets are **encrypted App Service app settings** today (Key Vault is blocked by the NIST 800-53 policy until a VNet + private endpoint exist — tracked hardening item).
- Never commit secrets. CI runs a secret-pattern scan on every push and fails on a match.
- Graph credentials are per-purpose app registrations (`Anchor-Provisioning`, per-customer device-sync apps) with the **minimum** application permissions. Each new permission needs a documented reason and admin consent in the target tenant.

## 6. Platform hardening (API)

`@fastify/helmet` security headers, `@fastify/rate-limit`, 1 MiB body cap, `trustProxy`, correlation IDs on every request, RFC 7807 errors that never leak stack traces.

## 7. Audit

- Security-relevant actions write to the **append-only, hash-chained** `audit_logs` table. Never `UPDATE` or `DELETE` audit rows.
- Hash input uses canonical JSON (recursively sorted keys) so verification is order-independent.

## 8. Supply chain

CI `security` job on every push: `npm audit` (high+), secret scan, CycloneDX **SBOM**, **CodeQL**, and dependency review on PRs (fails on high). High/critical findings are fixed or formally accepted with a dated note before release.

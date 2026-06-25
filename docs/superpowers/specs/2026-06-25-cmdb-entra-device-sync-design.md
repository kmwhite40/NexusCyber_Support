# CMDB Self-Population via Per-Customer Entra/Intune Device Sync

**Date:** 2026-06-25
**Status:** Approved design — ready for implementation planning
**Source:** Tier-2 item #5 ("CMDB that populates itself") in `docs/2026-06-25-anchor-next-level-recommendations.md`

## Problem & strategic fit

Anchor's CMDB (`configuration_items` + `ci_relationships`) exists but is hand-entered, so it is perpetually stale and adds friction instead of value. Across the competitor review (Freshservice, Jira Insight, Zendesk, Help Scout, HubSpot, Freshdesk), **asset/device auto-discovery → CMDB self-population is the single highest-leverage ITSM-parity gap** — and uniquely, it reinforces Anchor's strategic wedge: *the service desk that is also your compliance-evidence engine*. Pulling Intune compliance state onto device CIs is something no general helpdesk on that list does.

This design auto-creates and continuously reconciles `device` configuration items from each customer's Microsoft Entra / Intune tenant, enriched with Intune compliance/management state.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| App-registration model | **Per-customer app registration (max isolation)** | Gov MSP customers span clouds and many will not consent to a shared multi-tenant app; each customer owns a single-tenant app in their own tenant. |
| Secret storage | **App-layer AES-256-GCM envelope encryption in Postgres** | Key Vault is blocked by NIST policy in the gov enclave, so the `config.ts` "use Key Vault in production" path is unavailable. |
| Sync scope | **Entra devices + Intune compliance/management state** (no users, no groups) | Lights up the compliance-evidence differentiator; users/groups deferred. |
| CI lifecycle | **Upsert by external ID; retire (not delete) on disappearance** | Tamper-evident compliance evidence — never silently delete a device that fell out of compliance. |

## Architecture overview

A scheduled per-org sync job authenticates to each customer's **own single-tenant app registration**, enumerates that tenant's Intune-managed devices via Microsoft Graph, and upserts them as `device` configuration items enriched with compliance state.

A single Graph endpoint — `/deviceManagement/managedDevices` — covers **both** selected scopes (device identity *and* Intune compliance), so it is the enumeration spine. `azureADDeviceId` is the stable upsert match key.

Per-customer credentials live encrypted in a new `org_integrations` table. Each customer's run is isolated in its own try/catch: one tenant's bad credentials, missing consent, or throttling never blocks another tenant's sync.

Reuses existing, proven building blocks:
- `apps/api/src/integrations/m365/token.ts` — client-credentials token provider already parameterized by `tenantId`/`clientId`/`clientSecret`. Built **per org** instead of once globally.
- `apps/api/src/integrations/m365/graph-client.ts` — Graph client with `@odata.nextLink` paging and 429/503 backoff.
- `cloud_environments` table — maps `org.cloud` → `login_authority` / `graph_endpoint` (commercial/gcc/gcchigh/azgov).
- `audit()` hash-chain, RLS (`app_org_id()` / system context), the background-poller bootstrap used by mail ingest.

## Data model

### New table: `org_integrations`
One row per org per provider.

- `id uuid pk`, `organization_id uuid fk`, `provider text` (`'entra_graph'`)
- `tenant_id text` — customer Entra tenant GUID
- `client_id text` — the customer app registration's client ID
- `secret_ciphertext bytea`, `secret_iv bytea`, `secret_tag bytea`, `key_version int` — envelope-encrypted client secret
- `enabled boolean default false`
- `status text` — `unconfigured` | `ok` | `error`
- `last_sync_at timestamptz`, `last_error text`, `last_sync_stats jsonb`
- `created_at`, `updated_at`
- RLS `_isolation` policy mirroring other org-scoped tables.
- **Secret columns (`secret_ciphertext`/`secret_iv`/`secret_tag`) are only ever selected in system context by the sync/test path. The API layer's admin selects exclude them — secret material is never returned to any client.**

### Extend `configuration_items` (small migration)
- `source text not null default 'manual'` — synced rows use `'entra'`. Sync only ever touches `source='entra'` rows, so hand-entered CIs are never clobbered, and admins can filter discovered vs. manual.
- `external_id text` — provider's stable device id.
- Unique `(organization_id, source, external_id) where external_id is not null` — the upsert key.

### New table: `integration_sync_runs`
Run-level history (not per-CI):
- `id`, `organization_id`, `provider`, `started_at`, `finished_at`
- `created_count int`, `updated_count int`, `retired_count int`
- `status text` (`ok`|`error`), `error text`

Feeds the tamper-evident compliance-evidence trail and the integration health UI.

## Auth & secret handling

Per-customer app uses the **client-credentials** flow already in `token.ts`. The sync builds a token provider *per org* from its decrypted `client_id`/`client_secret` + the endpoints for `org.cloud` from `cloud_environments`.

**Envelope encryption (`integration-crypto` module):**
- Algorithm AES-256-GCM; random 12-byte IV per secret; auth tag stored alongside.
- 32-byte master key from App Service config `INTEGRATION_ENC_KEY` (base64), injected via managed identity at deploy time.
- `key_version` column supports key rotation without a flag day.
- Decryption happens only in the sync/test path under system DB context. A DB read alone never reveals a secret.
- **Residual trust boundary (documented):** because Key Vault is blocked, the master key lives in App Service environment config; anyone with both env access *and* DB read could decrypt. This is strictly stronger than plaintext-at-rest and is the best available option under the enclave's constraints. A future migration to managed-identity-derived keys is noted as follow-on.

## Sync engine

For each org with an `enabled` `entra_graph` integration:

1. Build the per-org Graph client (decrypt secret → token provider → graph client with `org.cloud` endpoints).
2. Page `/deviceManagement/managedDevices` via `@odata.nextLink`.
3. Upsert each device into a `device` CI:
   - `ci_class='device'`, `source='entra'`, `external_id=azureADDeviceId`
   - `name = deviceName`
   - `owner = userPrincipalName` (text; no user CI created)
   - `status='active'`
   - `criticality` left unset (operator decides; never inferred)
   - `attributes` jsonb: `{ os, osVersion, complianceState, isEncrypted, lastSyncDateTime, manufacturer, model, serialNumber, enrollmentType, managedDeviceId }`
4. **Reconciliation:** collect all seen `external_id`s. After a *successfully completed* enumeration, any `source='entra'` CI for that org that is currently `active` and not in the seen set → set `status='retired'`. Rows are never deleted.
5. **Safety rule:** if enumeration errors mid-run, record `status='error'` + `last_error` and **skip retirement** — a transient Graph failure must not mass-retire a fleet. Retirement runs only on a complete, successful enumeration.
6. Write an `integration_sync_runs` row and update `org_integrations.last_sync_at` / `last_sync_stats`.

**Triggers:**
- Scheduled job reusing the existing background-poller bootstrap; interval configurable (e.g. via env). Iterates orgs sequentially or with small bounded concurrency, each isolated.
- Manual `POST /api/v1/integrations/entra/sync` (admin, on-demand).

## Onboarding / admin UX

A per-org Integrations admin view, gated by a new `integrations.manage` permission:
- Enter `tenant_id` / `client_id` / `client_secret`.
- **Test connection** — acquire a token and `GET /deviceManagement/managedDevices?$top=1`.
- Enable / disable.
- See last-sync status, counts, and errors; **Sync now** button.
- Secret field is **write-only**: displays `configured · last set <date>`, never the value.
- Shows the exact consent the customer must grant in *their* app registration: **`DeviceManagementManagedDevices.Read.All`** (application permission, admin-consented).

## Permissions, audit, error handling

- New permission key `integrations.manage`.
- Audit (hash-chained), run-level not per-CI: `integration.entra.configured`, `integration.entra.secret_rotated`, `integration.entra.enabled`, `integration.entra.disabled`, `integration.entra.sync` (with counts).
- Error surfaces: missing consent, invalid credentials, and throttling set `status='error'` + `last_error`, shown in the UI, isolated per org. Graph 429/503 handled by the existing client backoff.

## Testing strategy

- **Unit:** encryption round-trip (encrypt→decrypt, wrong-key fails); pure device→CI mapping; reconciliation/retire logic with a fake seen-set including the completed-run gate; per-org token-provider construction.
- **Integration:** fake Graph client returning paged `managedDevices` → asserts create/update/retire correctness, that `source='manual'` CIs are untouched, and that an errored run does **not** retire any CI.
- **Security:** admin API never returns secret material; RLS blocks cross-org reads of `org_integrations`.

## Out of scope (YAGNI — clean follow-on passes)

- User and group sync (device `owner` is kept as text only; no user CIs).
- `device → owner` relationship CIs in `ci_relationships`.
- Graph delta queries / change-notification webhooks (full poll is fine at gov device counts).
- Key Vault integration (blocked by enclave policy).
- Automatic criticality inference.
- Non-Entra discovery sources (network scan, agents).

# M365 GCC Integration — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming)
**Related:** [docs/nexus/06-notifications-m365.md](../../nexus/06-notifications-m365.md) (Sections K & L)

## Goal

Replace the stubbed notification send path with a real Microsoft 365 **GCC** integration for a
single Nexus enclave **service mailbox**, and deliver the full Section L integration layer:
outbound email, inbound mail→ticket ingestion, Teams channel posting (enhancement, off by
default), and integration health + a live test probe.

The build is **config-wired with a dev transport**: all live Graph code is written and exercised
through a console transport locally, and flips to real M365 GCC the moment app-registration
credentials are supplied. No secrets are committed.

## Decisions (from brainstorming)

| Axis | Decision |
|------|----------|
| Scope | Full integration layer: email + inbound + Teams + health/test |
| Tenancy | Single Nexus enclave service mailbox (one GCC tenant, env/Key Vault config) |
| Run/test now | Config-wired live Graph code + console dev transport; live when creds present |
| Recipients | Resolve from domain context (assignee/requester/on-call/admins); honor opt-out |
| Inbound | Polling + delta (cron), subscription-ready abstraction |
| Credentials | Client-secret app-only (client-credentials) |
| Cloud fact | GCC uses commercial endpoints (`login.microsoftonline.com` / `graph.microsoft.com`); only GCC High/DoD use `.us` |

## Principles preserved

- **Endpoints are data, not code.** Login authority + graph endpoint come from the existing
  `cloud_environments` table, selected by the configured cloud. Credentials come from config.
- **No new runtime dependencies.** Raw `fetch` (Node 20 global) — no MSAL, Graph SDK, or
  Handlebars. Matches the repo's hand-rolled style.
- **Portal is the universal floor.** The fallback chain (Teams → Email → Portal) is unchanged in
  shape; only the leaf adapters become real.
- **Single codebase, per-cloud behavior via the capability matrix** (principle P5).

## Architecture

New self-contained directory `apps/api/src/integrations/m365/`:

```
integrations/m365/
  token.ts          # client-credentials token provider, in-memory cache + refresh
  graph-client.ts   # fetch wrapper: bearer auth, base URL from cloud_environments,
                    #   429/503 + Retry-After backoff w/ jitter, audit logging (no payload)
  adapter.ts        # NotificationAdapter interface (K.5) + selectAdapter()
  graph-adapter.ts  # real Graph email + Teams
  console-adapter.ts# dev transport: renders + records, no network
  ingest.ts         # fetchNewMessages() via /messages/delta; subscription-ready
  health.ts         # probes -> integration_health_checks; test() probe

modules/
  notifications.ts            # dispatch() rewritten to render + send + record per recipient
  notifications-recipients.ts # resolve recipient emails from a DomainEvent
  notifications-templates.ts  # event type -> {subject, html, text} with tenant branding
  integrations.ts             # health/test service backing the routes

jobs/
  mail-ingest.ts    # scheduler (sla-sweeper/conmon mold) calling ingest.fetchNewMessages()
```

`server.ts` registers the mail-ingest scheduler alongside the existing schedulers, and
`routes.ts` gains the two integration endpoints.

### Section 1 — Config & auth foundation

`M365Config` read from env and added to `.env.example` (no secrets committed):

| Var | Purpose |
|-----|---------|
| `M365_ENABLED` | Master switch. False/absent → console transport. |
| `M365_CLOUD` | `gcc` (default). Selects the `cloud_environments` row. |
| `M365_TENANT_ID` / `M365_CLIENT_ID` / `M365_CLIENT_SECRET` | App-only client-credentials. |
| `M365_SERVICE_MAILBOX` | UPN of the service mailbox (sends + ingests). |
| `M365_INGEST_ENABLED` | Inbound mail→ticket toggle. |
| `M365_TEAMS_ENABLED` | Teams channel posting toggle. Default **off** (L.5). |

- **`token.ts`**: `POST {login_authority}/{tenant}/oauth2/v2.0/token`,
  `grant_type=client_credentials`, `scope={graph_endpoint}/.default`. Cache token with expiry;
  refresh on/just-before expiry. (Certificate credential is a future drop-in; out of scope now.)
- **`graph-client.ts`**: `get`/`post` over `fetch`. Base URL from `cloud_environments.graph_endpoint`.
  Honors `429`/`503` + `Retry-After`, jittered exponential backoff (L.6), bounded retries. Audit-logs
  call class, target tenant, scopes, and result summary — never request/response payloads.

### Section 2 — Outbound email (core)

- **`adapter.ts`** — `NotificationAdapter` interface (K.5): `capabilities()`, `sendEmail(env)`,
  `sendTeams(env)` returning a `DeliveryResult` (`{status, providerMessageId?, error?}`).
  `selectAdapter()` returns `GraphAdapter` when `M365_ENABLED` + creds present, else `ConsoleAdapter`.
- **`graph-adapter.ts`** — `sendEmail` → `POST /users/{serviceMailbox}/sendMail` with the rendered
  message. `sendTeams` (Section 4).
- **`console-adapter.ts`** — renders the message and returns `sent` without network; the full pipeline
  (resolve → render → record) runs locally.
- **`notifications-recipients.ts`** — `resolveRecipients(evt): {userId, email}[]`:
  - ticket events (`ticket.*`, `sla.*`): the ticket's `assigned_agent_id` + `requester_id` emails.
  - on-call/paging events (`oncall.*`): on-call participant emails for the schedule.
  - posture events (`posture.*`): org admins (role assignment with an admin role).
  - Filters out users with `notification_preferences.email_enabled = false`.
- **`notifications-templates.ts`** — `render(eventType, ctx): {subject, html, text}`. A TS map of
  per-event renderers; tenant from-name/branding sourced from the org. No template engine.
- **`notifications.ts` `dispatch()` rewrite**:
  1. resolve cloud (existing) and recipients (new).
  2. walk preferred channels `[teams, email]`; for the first capability-`supported` channel, render
     and call the adapter once per recipient.
  3. record a `notification_deliveries` row per recipient with `status` from `DeliveryResult` and
     `provider_message_id`; on send failure, fall through to the next channel.
  4. always record the portal floor.
  5. persistent failure → `status='failed'` + log (DLQ stand-in; matches existing pattern).
  - Subscriptions extended to include `oncall.*` and `posture.finding_*` event types.

### Section 3 — Inbound ingestion (mail → ticket)

- **`ingest.ts` `fetchNewMessages()`** — `GET /users/{mailbox}/mailFolders/inbox/messages/delta`
  using a delta token stored in `integration_state`. Returns normalized messages; the same handler is
  callable from a future webhook path (subscription-ready).
- **`jobs/mail-ingest.ts`** — scheduler in the [sla-sweeper](../../../apps/api/src/jobs/sla-sweeper.ts)/conmon mold.
  No-op unless `M365_INGEST_ENABLED`.
- **Message → ticket**: create a ticket with `source_channel='email'`, subject/body from the message.
  Sender's email **domain mapped to an org** via `organization_domains`; **unmatched sender → log +
  skip** (no triage org in this cut). Dedupe by `internetMessageId` (tracked in `integration_state`).

### Section 4 — Teams, health & test

- **`graph-adapter.ts` `sendTeams`** — Graph channel post (Adaptive Card where validated), guarded by
  `M365_TEAMS_ENABLED`. When off/unsupported, the router substitutes email/portal and logs the
  substitution reason (already supported by `dispatch()`).
- **`health.ts` + `modules/integrations.ts`** — probes (token valid, a Graph read, mailbox reachable,
  delta-cursor age) recorded to `integration_health_checks`.
- **Routes**:
  - `GET /api/v1/integrations/m365/health` → latest checks + resolved capability matrix for the cloud.
  - `POST /api/v1/integrations/m365/test` → side-effect-safe probe (acquire token + `GET /users/{mailbox}`;
    optional test-send to a supplied address). Per-capability pass/fail with cloud context. Nexus-admin
    authz; audited.

### Section 5 — Migration, deps, testing

- **`0005_m365_integration.sql`**:
  - `notification_preferences(user_id uuid pk references users, organization_id uuid, email_enabled bool default true)`
  - `integration_state(integration text, key text, value jsonb, updated_at timestamptz, primary key (integration, key))`
  - `integration_health_checks(id, integration, check_name, status, detail jsonb, checked_at)`
  - Extend `notification_deliveries` with `provider_message_id text` and `attempts int default 0`.
  - RLS on org-scoped tables consistent with the existing pattern.
- **Dependencies:** none added.
- **Testing (vitest, mocked `fetch`/`sql`):**
  - token cache + refresh
  - graph-client retry honoring `Retry-After`
  - recipient resolution + opt-out filtering
  - template render (subject/body)
  - dispatcher: email when supported, portal fallback when not, per-recipient records
  - ingest: message→ticket mapping, dedupe, sender-domain→org
  - test-probe response shape

## Implementation tiers (for the plan)

1. **Foundation** — config, token provider, graph-client, adapter interface + console adapter.
2. **Email** — recipients, templates, graph email adapter, `dispatch()` rewrite, migration (prefs +
   deliveries columns). *Minimal shippable "notifications reach inboxes" win.*
3. **Inbound** — ingest + mail-ingest job + `integration_state`.
4. **Teams / Health / Test** — Teams adapter, health probes, routes, `integration_health_checks`.

## Out of scope (YAGNI / future)

- Certificate / managed-identity credentials (client-secret only for now).
- Per-customer-org tenants and per-org credential storage (single enclave mailbox now).
- Full preference center: quiet hours, digest batching, per-event opt-outs (single email on/off flag now).
- Graph change-notification **webhooks** (polling + delta now; abstraction is subscription-ready).
- Immutable `consent_record` table (admin grants out-of-band for a single enclave).
- GCC High / Azure Gov endpoints beyond what `cloud_environments` already seeds.

# Anchor two-way integration — external contract

Reference for an **external GRC system** (POA&M / risk-register / ConMon) syncing items into
Anchor (`anchor-api`) tickets and receiving status writeback. Server side implemented in
migration `0051_anchor_integration.sql` + `src/auth/api-key.ts`, `src/modules/api-keys.ts`,
`src/modules/webhooks.ts`. API base (gov): `https://anchor-api.azurewebsites.us`.

## Auth — per-organization API key (M2M)

`Authorization: Bearer ak_<keyId>_<secret>` — long-lived, revocable, no refresh. Scoped to
ONE org (request `organizationId` must match the key's org, else 403). Provision one key per
Anchor org. Held server-side by the caller only (never in a browser).

Mint (admin with `integration.manage` — OrgAdmin or ServiceDeskManager; secret shown once):
```
POST /api/v1/integration/api-keys
{ "organizationId": "<uuid>", "name": "ISSO GRC sync" }
→ { token, scopes:[ticket.create, ticket.read.organization, ticket.update, ticket.comment], ... }
```
Revoke: `DELETE /api/v1/integration/api-keys/:id`. List: `GET /api/v1/integration/api-keys`.

## Outbound — create/update a ticket

`POST /api/v1/tickets`

| field | type | notes |
|---|---|---|
| subject | string **req** | 3–300 |
| organizationId | uuid **req** | must match key's org |
| description | string? | |
| impact / urgency | int 1–4? | default 3; **priority derived** impact×urgency (no priority field) |
| severity | string? ≤40 | descriptive only |
| category | string? | |
| tags | string[]? | |
| customFields | object? | jsonb passthrough (metadata lands here) |
| externalRef | string? 1–200 | **idempotency key** — upserts same ticket |
| externalSource | string? ≤60 | originating system label |
| type | string? | default `incident` |
| serviceId | uuid? | optional CMDB link |

Response: full ticket row (`id`, `ticket_number`, `status='triage'`, `priority`, `external_ref`,
`severity`, `custom_fields`). **HTTP 201 = created, 200 = matched existing externalRef (updated).**

Severity → impact/urgency so priority derives: `critical→(1,1) P1 · high→(2,2) P2 ·
medium→(3,3) P3 · low→(4,4) P4`.

## Inbound — status writeback (webhooks)

Register the receiver (admin; secret shown once → HMAC key):
```
POST /api/v1/integration/webhooks
{ "organizationId":"<uuid>", "url":"https://.../anchor-webhook",
  "eventTypes":["ticket.status_changed","ticket.resolved","ticket.closed","ticket.reopened"] }
→ { id, secret, ... }
```
Anchor POSTs JSON with headers `X-Anchor-Event`, `X-Anchor-Delivery`,
`X-Anchor-Signature: sha256=<hex>` where signature = `HMAC-SHA256(secret, rawBody)` over the
**raw bytes**. Body:
```jsonc
{ "event_id","type","occurred_at","organization_id",
  "ticket":{ "id","ticket_number","status","priority","subject","external_ref","external_source" },
  "data":{ "ticket_id","org_id","from","to" } }
```
`ticket.external_ref` is the caller's `<tenantId>:<source>:<itemId>`. Dedupe on `event_id`.
Deliveries are recorded; inspect via `GET /api/v1/integration/webhooks/deliveries`.

Event types emitted: `ticket.created · status_changed · resolved · closed · reopened ·
assigned · escalated · commented`. Status vocab: `new · triage · assigned · in_progress ·
waiting_customer · waiting_vendor · on_hold · resolved · closed`.

## Notes
- Outbound create/upsert does NOT move ticket workflow status (Anchor owns lifecycle); status
  flows back via webhook. Pushing status INTO Anchor would need a dedicated transition endpoint.
- API-key principal is nexus-plane, scoped to its one org, holding only the bounded ticket
  verbs — it cannot reach admin/billing/elevation endpoints (403).
- SSRF guard on webhook URLs blocks private/loopback/link-local/metadata targets; https
  required in production.

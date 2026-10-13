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

## Outbound — strict upsert (preferred)

`POST /api/v1/integration/tickets` — same per-organization API key. **Prefer this over
`POST /api/v1/tickets`:** it takes the integration vocabulary directly and an unrecognised
field is a `422` rather than a silent drop.

`externalRef` is **required** (the endpoint is upsert-only) and is NOT validated as a uuid — a
programme-scoped key such as `carbon-conmon:backlog:WS-1.1` is accepted as-is.

### Applied

| field | type | notes |
|---|---|---|
| externalRef | string **req** | 1–200, the idempotency key |
| organizationId | uuid **req** | must match the key's org, else 403 |
| source | string **req** | ≤60 → `external_source` |
| title | string **req** | 3–300 → `subject` |
| description | string? | ≤20000 |
| severity | `critical`\|`high`\|`medium`\|`low`\|null? | **also drives priority**: critical→P1, high→P2, medium→P3, low→P4, null→P3 |
| sourceId | string? | → `external_source_id`; survives a change to the externalRef format |
| owner | string? | → `external_owner`, **text only — never sets the assignee** |
| controlIds | string[]? | → `control_ids` (queryable, GIN-indexed) |
| dueDate | RFC 3339 date-time? | → `external_due_at`, the CALLER's deadline, distinct from Anchor's SLA clock. A full timestamp with offset — `2026-11-30T00:00:00Z`, not `2026-11-30` |
| labels | string[]? | → `tags` |
| carbonUrl | url? | → `external_url` |
| metadata | object? | → `custom_fields` |

On an upsert, **key presence matters for the five integration columns** — `dueDate`, `owner`,
`controlIds`, `carbonUrl` and `sourceId`. An omitted key preserves the stored value; an explicit
`null` clears it. So `"dueDate": null` withdraws a deadline, while omitting `dueDate` keeps it.

For the other applied fields a `null` reads as "unset" and behaves like an omitted key: it
preserves what is stored rather than erasing it. The one field to watch is `severity` — send it
and Anchor recomputes priority; omit it and both severity and priority are left exactly as they
were, so a partial re-sync cannot downgrade a critical finding.

An upsert never changes `status`, the assignee or the ticket number — Anchor owns the lifecycle
and the assignment.

### `source: "backlog"` starts no SLA clock

An item whose `source` is exactly `backlog` is treated as a work record rather than a service
commitment: it is created, numbered and triaged like any other ticket, but no SLA instance is
started and `dueDate`-style response/resolution stamps stay null. Every other source keeps its
clock. Send `backlog` for programme/build work so it does not breach and escalate in the owning
organization's SLA reporting.

### Accepted but not applied

`status`, `priority` and `tenantId` are accepted and returned in the response's `ignored[]`
array. Anchor owns the lifecycle (status moves only via `/transition`), derives priority from
impact × urgency (there is no `P0`), and has no tenant concept. They are reported rather than
refused so a conformant payload keeps working — check `ignored[]` if you expect them to apply.

### Refused — 422

`parentExternalRef`, `estimateDays`, `phase`, `workstream`, `acceptanceCriteria` and
`blockedReason` (phase D, not yet supported), and **any unrecognised field**. The response is an
RFC 7807 problem document whose `errors[]` names each offending field.

### Response

```json
{ "ticketId":"...", "ticketKey":"DEMO-000123", "externalRef":"...", "status":"triage",
  "assignee":null, "dueDate":"2026-11-30T00:00:00.000Z",
  "createdAt":"...", "updatedAt":"...", "created":true, "ignored":["status","priority"] }
```

**HTTP 201 = created, 200 = matched an existing externalRef and updated it**, mirrored by
`created`. `status` and `assignee` are Anchor's authoritative values, not what was sent.
`dueDate` echoes `external_due_at` — your deadline, not Anchor's SLA `resolution_due_at`.

### Two things to know about metadata

- It round-trips **semantically, not byte-identically** — it is stored as `jsonb`, which
  normalises key order and whitespace. Hash a canonical form, or keep the hash on your side.
- A key an administrator has flagged `sensitive` on any request form is **refused with a 422**,
  not stripped. Namespace your keys to stay clear of the PII vault boundary.

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

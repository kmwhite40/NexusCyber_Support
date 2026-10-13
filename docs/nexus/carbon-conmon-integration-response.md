# Anchor's response to Carbon's ConMon integration requirements

**Status:** Anchor engineering's answer. Decisions marked **DECIDED** are Anchor's to make and are made here; items marked **NEEDS CARBON** are blocked on you.
**Date:** 2026-10-12
**Audience:** Carbon engineering.
**Responds to:** *Anchor — what it must provide for Carbon Application ConMon* (2026-10-12).

> **Read this first:** the integration you specified largely already exists and is deployed.
> Migration `0051_anchor_integration.sql` shipped M2M API keys, `external_ref` idempotent
> upsert, and HMAC-signed outbound webhooks in 2026-06, and the contract has been published
> since then at [`docs/nexus/anchor-integration-external-contract.md`](anchor-integration-external-contract.md)
> (decision record: `ADR-0013`). Please build against that document — it is the normative
> field list. This file covers only the **delta** your spec asks for.

---

## 1. Summary

| Your phase | Verdict |
|---|---|
| **A** | **Already live**, except for three items in §2. Your spec's phase-A list — upsert on `externalRef`, unique index, `Idempotency-Key`, per-org auth with `403` on scope violation, non-uuid first ref segment, null `tenantId` — is shipped and in production today. |
| **B** | Half-built. Webhooks exist with per-org HMAC secrets and delivery audit, but do not meet your §5 wire format. `PATCH` does not exist. **Reopen-from-closed does not work** (§4.5). |
| **C** | Not built. Both items are feasible; the delta feed is cheap. |
| **D** | Not built. Mostly additive, with one design objection in §6. |

**The real phase-A blocker is not a missing feature — it is field naming.** Your §2.1
payload, posted at Anchor today, returns `400` on the first call and would silently discard
two-thirds of its fields on a corrected one. Details in §2. This is the thing to fix in
Sprint 1, and most of the fix is on Carbon's side.

---

## 2. Your §2.1 payload against the live endpoint

`POST /api/v1/tickets` parses with a non-strict schema, so **unrecognised keys are stripped
without error**.

| Your field | What happens today |
|---|---|
| `externalRef` | ✅ Accepted, `1–200` chars, **not validated as a uuid**. Your §3 concern is already satisfied — a `carbon-conmon:backlog:WS-1.1` key works unchanged. |
| `source` | ✅ Accepted as **`externalSource`** (≤60). Different name. |
| `title` | ❌ Anchor's field is **`subject`** (required, 3–300). Your payload has no `subject` → **`400`**. |
| `description` | ✅ |
| `labels` | ❌ Anchor's field is **`tags`**. Dropped. |
| `metadata` | ❌ Anchor's field is **`customFields`**. Dropped. |
| `severity` | ✅ Free text ≤40, nullable. Your §7 ask — "severity must become nullable" — needs no change: it already is, on both the API and the column. |
| `organizationId` | ✅ Required, and must match the key's org or `403`. |
| `tenantId` | Ignored. **Anchor has no tenant concept** — organizations are the only boundary. Stop sending it. |
| `priority` | Ignored. See §3.2. |
| `status` | Ignored. Anchor owns lifecycle; see §3.3. |
| `dueDate`, `owner`, `controlIds`, `sourceId`, `carbonUrl` | Dropped silently. No home today. |
| All of your §7 backlog fields | Dropped silently. |

The response is also not your §2.1 shape: it is the ticket row (`id`, `ticket_number`,
snake_case throughout). There is no `created` boolean — that signal is the **HTTP status:
`201` created, `200` matched an existing `externalRef` and updated it**.

### 2.1 DECIDED — a dedicated integration endpoint, and strict parsing

Anchor will add **`POST /api/v1/integration/tickets`** accepting your §2.1 payload verbatim
and returning your §2.1 response shape (`ticketId`, `ticketKey`, `externalRef`, `created`, …).

Two deliberate choices:

- **A separate route, not a widened `POST /api/v1/tickets`.** That route is shared by the
  agent UI, the customer portal, the service catalog and mail-to-ticket ingest. Adding
  fifteen integration-only fields and a second response shape to it would couple human
  intake to Carbon's contract, and every future change to your payload would land in the
  path that creates tickets for humans.
- **The new route parses strictly: an unknown field is a `422`, not a silent drop.** This is
  the single highest-value item in this whole document. The failure mode you would otherwise
  hit is not an outage — it is Carbon logging a successful sync for months while `dueDate`,
  `owner` and `controlIds` go nowhere, and nobody finding out until an auditor asks why a
  POA&M has no due date.

**Until that endpoint ships, Carbon can go live on the existing contract with no Anchor
deploy at all** by mapping `title→subject`, `labels→tags`, `metadata→customFields` and
setting `impact`/`urgency` per §3.2. That unblocks S1.7 immediately; treat the new endpoint
as the thing that gives your remaining fields a real home.

---

## 3. Corrections to assumptions in your spec

### 3.1 `metadata` cannot be returned byte-identical
It lands in a `jsonb` column, which normalises key order and whitespace. You will get it
back **semantically** identical, never byte-identical. If you are hashing it, hash a
canonicalised form or keep the hash on your side.

Also: Anchor **refuses with `422`** any `customFields` key that an administrator has flagged
`sensitive` on any request form — it is a deny-list on key *names*, protecting the PII vault
boundary. It is a loud refusal, not a strip. If `metadata` may carry a key like
`personal_email`, namespace your keys (e.g. `carbon.*`) to stay clear of it.

### 3.2 Severity does not drive priority; impact and urgency do
Anchor derives `priority` (**`P1`–`P4`, there is no `P0`**) from an impact × urgency matrix
and **ignores a caller-supplied `priority`**. `severity` is descriptive only. To make Anchor's
priority track your finding severity, send `impact`/`urgency`:

`critical→(1,1) P1 · high→(2,2) P2 · medium→(3,3) P3 · low→(4,4) P4`

This answers your §7 / Q2 directly: **nullable `severity` plus a separate ordering field is
already Anchor's shape.** No discriminated union is needed. For backlog items your `P0|P1|P2`
is a *different* axis from Anchor's derived priority and will be stored as its own field — it
must not be mapped onto Anchor's `priority` column, for exactly the reason you give.

### 3.3 You cannot push `status` in
Anchor owns the ticket lifecycle. The upsert does not move workflow status; status flows back
to you via webhook. Moving a ticket requires `POST /api/v1/tickets/:id/transition`, which is
outside an API key's default scopes. This is also how `blocked` will be set (§6).

### 3.4 Endpoint and auth corrections
- Your §2 item 3 wants `GET /health`. Anchor exposes **`/healthz`** (liveness + build commit)
  and **`/readyz`** (readiness, `503` when the database is unreachable). Both unauthenticated.
  Point your connector-health probe at `/readyz`.
- Your §4 asks for OAuth 2.0 client credentials from Entra ID. Anchor has **only** the
  per-organization API key — your stated phase-A fallback. It is long-lived, revocable,
  scrypt-hashed at rest, and rotatable with zero downtime (mint the new key, cut over, revoke
  the old). Entra client credentials for M2M are not planned; raise it if it is a hard
  compliance requirement rather than a preference.

---

## 4. Answers to your §10 open questions

1. **Work-item hierarchy** — yes, Anchor has one: a `parent_ticket_id` column plus a
   `child_of` link type. You should send `parentExternalRef`; **Anchor will resolve it to a
   ticket id server-side**, so you never need a lookup round trip. Order does not matter —
   if the parent has not arrived yet, the link is deferred rather than rejected.
2. **Severity vs priority** — answered in §3.2. Nullable `severity` already; `priority` stays
   Anchor-derived; your backlog `P0|P1|P2` gets its own field. No payload union.
3. **`GET /tickets?updatedSince=`** — feasible and cheap. `tickets` already maintains
   `updated_at` via trigger. Anchor will add a `(organization_id, updated_at)` index, keyset
   pagination on `(updated_at, id)` with a **stable ascending order and an opaque cursor**,
   default page 100 / max 500. Caveat you must handle: a row updated during your scan can
   appear twice — dedupe on `ticketId`. Today's `GET /tickets` has no cursor at all and
   hardcodes `has_more: false`; do not build against it.
4. **Per-organization webhook secrets** — yes, already the case, and finer-grained than you
   asked: one secret **per registered endpoint** per org, generated server-side and returned
   exactly once from `POST /api/v1/integration/webhooks`. Rotation is register-new →
   cut over → delete-old. No global secret exists.
5. **Reopen semantics** — **this is the one hard requirement Anchor fails today.** The default
   transition map makes `closed` terminal (`closed: []`); only `resolved → reopened` works.
   Anchor will add `closed → reopened` to the default map. Identity and history are preserved
   either way: it is the same row, same `ticketId`, same `ticketKey`, same comment thread, and
   it is repeatable. Note the status you will observe is **`reopened`**, not `open`, and it
   moves to `in_progress` from there. Anchor has **no delete endpoint for tickets**, so your
   §6.3 is satisfied by construction.
6. **Rate limits** — 300 requests/minute, and note **it is currently per-IP, not per-key**, so
   your egress IP is the bucket. `Retry-After` is returned on `429`. A per-key limit will
   replace it when the delta feed ships; a batch import of 72 items is nowhere near the limit.
7. **Carbon deep link** — send `carbonUrl`; Anchor will store and render it on the ticket.
8. **Org-to-project mapping** — **one Carbon organization maps to one Anchor organization.**
   Not a project, not a label. An API key is bound to exactly one organization and the policy
   decision point rejects any `organizationId` outside it with `403`. Your §4 concern that
   "both ends must check" is already true on Anchor's end, independent of whatever Carbon
   does. See §6 for which org the *backlog* belongs to — that one is not settled.

---

## 5. Webhook conformance gaps (your §5)

Shipped and conformant: per-org HMAC-SHA256 over the raw body, `externalRef` in the payload
(as `ticket.external_ref`, so no lookup needed), stable delivery id, delivery audit via
`GET /api/v1/integration/webhooks/deliveries`, SSRF guard on registered URLs, https required
in production.

Non-conformant, and what Anchor will change in phase B:

| Your §5 requirement | Today | Change |
|---|---|---|
| hex signature in `X-Anchor-Signature` | `sha256=<hex>` (GitHub-style prefix) | **Carbon strips the prefix** — Anchor keeps it. Existing receivers depend on it. |
| `X-Anchor-Timestamp`, signed, 5-min window | absent | will add |
| `X-Anchor-Delivery-Id` | header is `X-Anchor-Delivery` | will rename, keeping the old header for one release |
| ≥6 attempts over ~1 hour | **3 attempts over ~750ms** | will add durable, backed-off retry |
| retry on Carbon `5xx` | yes, but inside that 750ms window | as above |
| `resolution` on close | absent | will add (`fixed` / `wont-fix` / `duplicate` / `risk-accepted`) |
| `ticket.updated` event | absent | will add. Anchor additionally emits `ticket.resolved`, `ticket.closed`, `ticket.escalated` — subscribe to what you need. |
| payload field names | snake_case (`event_id`, `occurred_at`, `previous_status`) | **unchanged** — camelCase in your §5 does not match the shipped contract and other receivers exist |

One thing you should know, because it affects your reconciler's design: **webhook dispatch is
currently in-process and fire-and-forget.** A delivery in flight when the API restarts is
lost, with no dead-letter queue. Your §2 item 7 argument for the delta feed is therefore
right, and stronger than you knew — treat the delta feed as the source of truth and webhooks
as a latency optimisation, not the other way round.

---

## 6. NEEDS CARBON — which organization owns the 72 backlog items?

Your §1 says Anchor owns backlog items outright, and your §3 says a backlog item has no
tenant. Neither says **which Anchor organization they are created in**, and there is no
"no organization" option: `organization_id` is `NOT NULL` on tickets and is the tenant
isolation boundary for row-level security.

This matters more than it looks. An Anchor ticket is not a neutral work item. It gets:

- a **ticket number from the owning org's name prefix** (`SBSF-000123`);
- a **response and resolution clock started at creation, unconditionally** — so your 72
  estimates become deadlines that breach and escalate, which is exactly what your §1 table
  says must not happen. Note this is not configurable: SLA targets are hardcoded per derived
  priority and an `sla_instances` row is written for every ticket on every path. There is no
  "bind no SLA policy" escape hatch, so **suppressing the clock for backlog items is a
  required code change in Anchor, not a setup choice**;
- a place in that org's **queues, dashboards, KPI reports and CSAT surveys**.

Import them into the SBS Federal organization and you put 64 engineering stories into a live
customer's service-desk queue and SLA reporting.

**Anchor's recommendation:** provision a dedicated Anchor organization for the programme
(e.g. `Carbon ConMon Programme`) with its own API key, and excluded from operational
dashboards. Backlog items then live in their own tenant, `externalRef` keeps your preferred
`carbon-conmon:backlog:WS-1.1` form, and nothing leaks into customer reporting. Anchor will
**also** suppress clock start for tickets arriving with `source: backlog` — per the bullet
above that suppression is mandatory either way, because a separate organization isolates the
reporting but does not stop the clock.

Confirm that choice and Anchor will provision the org and the key. **This is the decision
that gates the backlog import — not phase D.**

Also still needed from you:

1. **Is a Jira/Anchor ticket the right container for build backlog at all**, or would an epic
   tree in your own planning tool serve better? Anchor will take the 72 items if you want
   them; we are flagging that the fit is imperfect and the §1 "no clock" requirement is
   fighting the entity's design.
2. **Who provisions and rotates the keys** — an SBS administrator with `integration.manage`
   must mint them, and the secret is shown exactly once. Name the recipient on your side.

---

## 7. Anchor's build order

| Anchor phase | Deliverable | Status |
|---|---|---|
| **A (live)** | `externalRef` upsert + unique index + `Idempotency-Key` + per-org key auth with `403` scope rejection + non-uuid ref segments + nullable severity + `/healthz` `/readyz` | **deployed since 2026-06** |
| **A′** | `POST /api/v1/integration/tickets` with your §2.1 request/response shape, **strict parsing (`422` on unknown fields)**, real homes for `dueDate` / `owner` / `controlIds` / `carbonUrl`, `parentExternalRef` resolution, **mandatory SLA-clock suppression for `source: backlog`** | gates S1.7; Carbon can ship against the existing contract meanwhile |
| **B** | `closed → reopened`; `PATCH /tickets/:id`; webhook timestamp + delivery-id rename + durable retry + `resolution` + `ticket.updated` | your M2.7 |
| **C** | delta feed with keyset cursor + `(organization_id, updated_at)` index; batch `externalRef` lookup (200/request); per-key rate limits | your WS-7.8 |
| **D** | backlog fields (`priority`, `estimateDays`, `phase`, `workstream`, `acceptanceCriteria`) + `blocked` status + `blockedReason` | ships with A′ |

`blocked` needs no schema change — statuses are per-organization configurable rows in
`workflows`/`workflow_transitions`. Note Anchor already has `on_hold` and `waiting_vendor`,
which may cover your "blocked on an external contract" case without a new status; your call.

### One note on your §9
Your plan to widen `AnchorSource` and `AnchorStatus` is right, but `tenantId` does not need to
become nullable for Anchor's sake — Anchor ignores the field entirely. Make it nullable if it
helps your own types; don't do it on our account.

---

## Appendix — the normative field list

This document is a delta. For the authoritative request/response shapes, auth flow, webhook
body, status vocabulary and the severity → impact/urgency mapping, build against
[`docs/nexus/anchor-integration-external-contract.md`](anchor-integration-external-contract.md).
Where the two disagree, the contract wins and this file is stale.

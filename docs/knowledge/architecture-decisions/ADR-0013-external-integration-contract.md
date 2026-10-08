# ADR-0013 — External integration: scoped API keys, idempotent upsert, signed webhooks

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06 |
| **Related** | `docs/nexus/anchor-integration-external-contract.md`; migration 0051; `auth/api-key.ts`, `modules/webhooks.ts` |

## Context
An external GRC system needs two-way sync with Anchor tickets: create/update tickets from its items and receive status changes back, without a human session.

## Decision
- **Inbound auth:** M2M API keys `ak_<keyId>_<secret>`, scrypt-hashed at rest, scoped to **one organization** and a bounded set of ticket verbs (`ALLOWED_KEY_SCOPES`).
- **Idempotent upsert:** tickets carry an `external_ref` (`<tenantId>:<source>:<itemId>`); replays update, never duplicate.
- **Outbound:** status changes are delivered as **HMAC-signed webhooks**; receivers verify the signature.
- Mutating calls also accept `Idempotency-Key`.

## Consequences
**Positive:** safe retries on both sides; a leaked key is limited to one org's tickets.
**Negative:** key rotation and webhook secret rotation are manual operational tasks.

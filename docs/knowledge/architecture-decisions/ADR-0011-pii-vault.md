# ADR-0011 — Onboarding PII held in a vault, not in ticket fields

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09 |
| **Related** | ES-05; `tickets-sensitive-fields.test.ts`, `catalog-request-pii.test.ts` |

## Context
New-hire requests collect personal data (home address, personal email, etc.). Ticket `custom_fields` are broadly readable by anyone who can see the ticket, appear in exports and are kept for the ticket's retention period.

## Decision
- Fields marked sensitive are stored in a separate **PII vault**, referenced from the ticket.
- Reading requires the **`pii.view`** permission; every read is **audited**.
- Vault contents are **purged when the ticket closes**.
- Sensitive fields are never written to the Entra GAL, notifications or logs.

## Consequences
**Positive:** least-privilege access to PII; limited retention; per-read evidence.
**Negative:** UI must handle a missing/purged reference null-safely (see `585b738`).

# ADR-0015 — RFC 7807 problem errors and Idempotency-Key on mutations

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Related** | Spec §T.1; ES-01; `errors.ts`, `http/idempotency.ts` |

## Context
The web UI, the external integration and operators all need errors they can act on, and retries (network blips, double-clicks) must not create duplicates.

## Decision
- All API errors are **RFC 7807** problem documents with a stable `code`, plus `errors[]` (`field`, `message`) for validation failures.
- `409 conflict` (operation already in progress) is distinct from *precondition failed* (stale etag/fingerprint — re-read before retrying).
- Mutating requests honour an **`Idempotency-Key`** header (in-memory store today).

## Consequences
**Positive:** predictable client handling; field-level error display.
**Negative:** the idempotency store is per-process and not durable — same caveat and revisit trigger as ADR-0005.

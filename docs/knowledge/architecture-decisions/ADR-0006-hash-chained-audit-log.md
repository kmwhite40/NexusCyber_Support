# ADR-0006 — Append-only, hash-chained audit log

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Related** | Spec ADR-013; ES-05; `modules/audit.ts` |

## Context
Federal customers need tamper-evident evidence of who did what, including PII reads and tenant changes.

## Decision
All security-relevant actions write to `audit_logs`, append-only. Each row stores a hash over its canonical content and the previous row's hash. Canonical JSON with **recursively sorted keys** is used so the verifier recomputes the same hash regardless of key order. An export and verify endpoint exists.

## Consequences
**Positive:** tampering or deletion is detectable; evidence for AU-2/AU-9/AU-10.
**Negative:** chain writes serialize; audit rows can never be corrected, only annotated.
**Follow-up:** ship to immutable (WORM) storage / SIEM per spec ADR-013.

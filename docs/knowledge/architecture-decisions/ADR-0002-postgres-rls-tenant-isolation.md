# ADR-0002 — Tenant isolation with Postgres RLS plus an application org-guard

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Related** | Spec ADR-001, ADR-004; ES-04, ES-05 |

## Context
Anchor is multi-tenant: SBS operators work across customer organizations, while customer users must only ever see their own organization. A single missed `WHERE organization_id = …` must not become a data leak.

## Decision
- One shared PostgreSQL database with **Row-Level Security** on every tenant table.
- Requests run as the non-owner role **`nexus_app`** inside a transaction that sets `app.plane`, `app.org_id`, `app.assigned_orgs` and `app.elevated` via `set_config(..., is_local => true)`.
- The application **also** checks org scope (org-guard / PDP) — defence in depth.
- Global/system work uses the owner role through an explicit `withSystemContext`.

## Alternatives considered
| Option | Why not |
|---|---|
| App-layer filtering only | One forgotten predicate leaks data. |
| Database per tenant | Operational overhead; breaks cross-customer operator views. |
| Schema per tenant | Migration fan-out; same cross-tenant problem. |

## Consequences
**Positive:** isolation enforced by the database even when application code is wrong.
**Negative:** querying with the app role and no context returns **empty results, not an error** — a known operator trap. Owner-role code paths must be few and commented.
**Follow-up:** spec ADR-001's dedicated database for high-sensitivity tenants remains available but unused.

## Security & compliance
Supports AC-3 / AC-4 (access enforcement, information flow). Cross-org access is audited.

# ADR-0004 — Two identity planes and a deny-by-default policy decision point

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Related** | Spec ADR-002; ES-05 |

## Context
SBS operators (service desk, security analysts, admins) and customer users (end users, org admins) sign in to the same product with different authority and different identity providers.

## Decision
- Every principal belongs to one **plane**: `nexus` or `customer`.
- Authorization goes through a single **PDP** (`authz/pdp.ts`) combining RBAC (role → permission verbs) and ABAC (org scope, assignment, elevation). Default is **deny**.
- Permission verbs are granted by migration.
- `admin.superuser` is a wildcard verb with cross-org scope, held only by named platform SuperAdmins and granted in the database (no Entra app role).
- Auth sources: Entra OIDC (agents, customer SSO), scrypt password login, and scoped M2M API keys.

## Consequences
**Positive:** one place to reason about "who can do what"; testable in isolation (`pdp.test.ts`).
**Negative:** SBS staff can hold both a customer row and a nexus row for the same email; which one signs in depends on the sign-in button. Documented, but surprising.

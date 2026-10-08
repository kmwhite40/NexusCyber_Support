# ADR-0009 — Every tenant-touching integration behind an off-by-default flag

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06 → 2026-09 |
| **Related** | Spec ADR-003, ADR-007; ES-06 |

## Context
Anchor can create and disable accounts, assign licences, convert mailboxes and purge records in customer Microsoft 365 tenants (GCC High). Code can be deployed long before it is safe to run.

## Decision
Each capability has its own environment flag on `anchor-api`, default **false**: `M365_ENABLED`, `M365_INGEST_ENABLED`, `M365_TEAMS_ENABLED`, `M365_PROV_ENABLED`, `M365_OFFBOARD_ENABLED` (ANDed with provisioning), `ENTRA_SYNC_ENABLED`, `RETENTION_PURGE_ENABLED`, `OIDC_*`, `SELF_SIGNUP_ENABLED`. Sovereign-cloud differences (e.g. Graph API version for Cloud PC) are also config, not code.

## Consequences
**Positive:** deploy and enable are separate decisions; an incident can be stopped by flipping a flag without a deploy.
**Negative:** flags drift from documentation — flag changes must be recorded as changes (ES-07). Some capabilities are shipped but unused (e.g. scheduled Entra sync runs manual-only while `ENTRA_SYNC_ENABLED` is unset).

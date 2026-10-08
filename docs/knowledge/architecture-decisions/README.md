# Architecture Decision Records — Anchor

ADRs record **why** Anchor is built the way it is. They describe the system **as built** (2026-06 → 2026-10). The original product specification has its own ADR-001…016 in `docs/nexus/12-risk-adr-diagrams.md`; where the build deviated from the spec, the ADR below says so.

## How to add one
1. Copy [ADR-0000-template.md](ADR-0000-template.md) to the next number.
2. Status starts **Proposed**; it becomes **Accepted** when merged.
3. Never rewrite an accepted ADR's decision. Supersede it with a new ADR and update the old one's status line.

## Index

| # | Decision | Status | Spec link |
|---|---|---|---|
| [0001](ADR-0001-monorepo-typescript-fastify-nextjs.md) | TypeScript monorepo: Fastify API + Next.js web | Accepted | §V |
| [0002](ADR-0002-postgres-rls-tenant-isolation.md) | Postgres RLS + application org-guard | Accepted | ADR-001, 004 |
| [0003](ADR-0003-forward-only-sql-migrations.md) | Forward-only SQL migrations, seed dual-write | Accepted | — |
| [0004](ADR-0004-identity-planes-and-pdp.md) | Two identity planes + deny-by-default PDP | Accepted | ADR-002 |
| [0005](ADR-0005-in-process-event-bus.md) | In-process event bus (for now) | Accepted — deviates | ADR-005 |
| [0006](ADR-0006-hash-chained-audit-log.md) | Append-only, hash-chained audit log | Accepted | ADR-013 |
| [0007](ADR-0007-azure-government-app-service.md) | Azure Government App Service, not AKS | Accepted — supersedes for now | ADR-003, 015 |
| [0008](ADR-0008-digest-pinned-deploys.md) | Digest-pinned deploys verified by build SHA | Accepted | ADR-015 |
| [0009](ADR-0009-integration-kill-switches.md) | Off-by-default integration flags | Accepted | ADR-003, 007 |
| [0010](ADR-0010-planner-executor-provisioning.md) | Planner + resumable executor for tenant changes | Accepted | — |
| [0011](ADR-0011-pii-vault.md) | PII vault outside ticket fields | Accepted | — |
| [0012](ADR-0012-vendored-ui-no-runtime-cdn.md) | Vendored UI, no runtime CDN | Accepted | §V.2 |
| [0013](ADR-0013-external-integration-contract.md) | API keys, idempotent upsert, signed webhooks | Accepted | — |
| [0014](ADR-0014-temporary-password-credential.md) | Temporary password instead of TAP | Accepted | — |
| [0015](ADR-0015-rfc7807-errors-and-idempotency.md) | RFC 7807 errors + Idempotency-Key | Accepted | §T.1 |

## Open architecture debt
- **ADR-0005 / 0015:** events and idempotency keys are in memory — move to a durable broker/store before scaling out.
- **ADR-0007:** Key Vault + VNet/private endpoints to replace App Service secret settings.
- **ADR-0006:** export the audit chain to WORM storage / SIEM.

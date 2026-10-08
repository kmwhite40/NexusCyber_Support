# Tech Radar — Anchor

| | |
|---|---|
| **As of** | 2026-10-08 |
| **Rings** | **Adopt** (default choice) · **Trial** (in use, still proving) · **Assess** (worth investigating) · **Hold** (don't start new use) |

## Languages & frameworks
| Item | Ring | Notes |
|---|---|---|
| TypeScript (strict) | Adopt | Front and back end ([ADR-0001](architecture-decisions/ADR-0001-monorepo-typescript-fastify-nextjs.md)) |
| Node.js 20/22 | Adopt | CI on 20, web runtime on 22 |
| Fastify 5 | Adopt | API framework; upgrade from 4 completed |
| Next.js 15 (App Router) | Adopt | Deployed as standalone bundle |
| React 18 | Adopt | Assess React 19 alongside a Next.js upgrade |
| Tailwind CSS 3 | Adopt | Assess v4 migration |
| zod | Adopt | Validation at every boundary |
| ORMs (Prisma, TypeORM) | Hold | Raw SQL keeps RLS context explicit ([ADR-0002](architecture-decisions/ADR-0002-postgres-rls-tenant-isolation.md)) |

## Data
| Item | Ring | Notes |
|---|---|---|
| PostgreSQL 16 + RLS | Adopt | Single shared DB, tenant isolation in the database |
| Azure PostgreSQL Flexible Server | Adopt | usgovtexas |
| Forward-only SQL migrations | Adopt | [ADR-0003](architecture-decisions/ADR-0003-forward-only-sql-migrations.md) |
| Postgres full-text search | Adopt | KB search |
| Dedicated DB per sensitive tenant | Assess | Spec option, not yet needed |

## Platform & infrastructure
| Item | Ring | Notes |
|---|---|---|
| Azure Government App Service | Adopt | [ADR-0007](architecture-decisions/ADR-0007-azure-government-app-service.md) |
| Azure Container Registry + ACR Tasks | Adopt | Builds without local Docker |
| Bicep | Adopt | `infra/azure/` |
| Digest-pinned deploys | Adopt | [ADR-0008](architecture-decisions/ADR-0008-digest-pinned-deploys.md) |
| Key Vault + VNet private endpoints | Trial (planned) | Blocked by NIST policy until networking exists |
| Azure Service Bus / Event Grid | Assess | When scaling past one API instance ([ADR-0005](architecture-decisions/ADR-0005-in-process-event-bus.md)) |
| AKS | Hold | Not justified at current scale |
| Mutable `:latest` image deploys | Hold | App Service serves the cached image |

## Integrations
| Item | Ring | Notes |
|---|---|---|
| Microsoft Graph (GCC High, v1.0) | Adopt | Through `integrations/` only |
| Microsoft Graph beta | Trial | Only where GCC High v1.0 is incomplete (Cloud PC status), pinned via config |
| Entra ID OIDC | Adopt | Agent plane + customer SSO |
| Windows 365 Cloud PC provisioning | Trial | Live for SBS |
| Entra/Intune device sync (CMDB) | Trial | Manual runs only until `ENTRA_SYNC_ENABLED` is set |
| M365 offboarding | Trial | Enabled, not yet run on a real departure |
| Temporary Access Pass | Hold | Replaced by temporary password in GCC High ([ADR-0014](architecture-decisions/ADR-0014-temporary-password-credential.md)) |
| Teams incoming webhooks | Hold | Deprecated / gov-limited — use Graph |
| HMAC-signed webhooks | Adopt | Outbound integration ([ADR-0013](architecture-decisions/ADR-0013-external-integration-contract.md)) |

## Quality & security tooling
| Item | Ring | Notes |
|---|---|---|
| Vitest + Testing Library | Adopt | API and web |
| GitHub Actions CI | Adopt | Typecheck · tests · build · security |
| CodeQL, dependency review, CycloneDX SBOM | Adopt | Every push |
| Prometheus `/metrics` | Adopt | In-process counters |
| pino structured logging | Adopt | |
| ESLint / Prettier | Assess | No linter configured today; style enforced by review |
| End-to-end browser tests (Playwright) | Assess | Would cover the provisioning and CAB flows |
| AI assist (per-tenant, off by default) | Trial | Spec ADR-014 rules apply |

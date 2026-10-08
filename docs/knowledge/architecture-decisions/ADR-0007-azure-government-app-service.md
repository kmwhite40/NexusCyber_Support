# ADR-0007 — Host on Azure Government App Service (not AKS)

| | |
|---|---|
| **Status** | Accepted — **supersedes spec ADR-015 for the current scale** |
| **Date** | 2026-06-12 |
| **Related** | Spec ADR-003, ADR-015; ES-07; `infra/azure/*.bicep` |

## Context
Anchor serves federal customers and must stay inside the US Government cloud boundary. The spec targeted AKS with blue/green deploys. The team is small and the workload is modest.

## Decision
- **Web:** App Service (Linux, Node 22, code deploy) in **usgovvirginia**, serving a pre-built Next.js standalone bundle.
- **API:** App Service for Containers in **usgovtexas**, image from ACR.
- **DB:** PostgreSQL Flexible Server in **usgovtexas**.
- Infrastructure in **Bicep**.
- Secrets in encrypted App Service settings (see consequences).

## Why two regions
Postgres Flexible was offer-restricted in usgovvirginia for this subscription and the B1 plan hit a capacity conflict there, so the backend moved to usgovtexas.

## Alternatives considered
| Option | Why not |
|---|---|
| AKS | Cluster operations and hardening far outweigh the benefit at one API instance. |
| Commercial Azure | Outside the required data boundary. |

## Consequences
**Positive:** minimal operations; managed TLS, patching and scaling.
**Negative:** web↔API traffic crosses regions; App Service quirks (cached `:latest` images, startup-command tokenization) needed workarounds (ADR-0008).
**Hardening debt:** NIST 800-53 Azure Policy denies Key Vault without purge protection and a locked firewall, and a locked vault needs a VNet + private endpoint. Until then secrets are App Service settings. **Follow-up:** VNet integration, private-endpoint Key Vault, `@Microsoft.KeyVault(...)` references.

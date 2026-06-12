# Nexus Platform — Enterprise ITSM / MSP / Posture Specification

> **Status:** Draft v0.1 — Implementation-ready product & engineering specification
> **Owner:** Nexus Platform Engineering / Product
> **Audience:** Enterprise IT, Engineering, Security, Compliance, Operations, Customer Success, Executive Leadership, Government-sector reviewers
> **Classification:** Internal — Nexus Confidential

---

## 0. What this is

This repository is the complete product and engineering specification for the **Nexus** platform — an enterprise-grade IT Helpdesk, ITSM, CSP/MSP operations, on-call, posture-management, and customer-support ticketing platform operated by Nexus (a Managed Service Provider / Cloud Solution Provider) across **commercial, GCC, GCC High, and Azure Government** customer environments.

It is written to be credible and actionable for engineering execution, product planning, security review, and compliance planning simultaneously. It does not describe a generic helpdesk; it specifies a multi-tenant, government-cloud-aware, posture-centric service platform.

## 1. Reading order / document map

| File | Required Sections | Topic |
|------|-------------------|-------|
| [README.md](./README.md) | — | This index, conventions, glossary |
| [01-foundation.md](./01-foundation.md) | A, B, C | Executive summary, product principles, personas / RBAC / ABAC |
| [02-architecture.md](./02-architecture.md) | D, E | Multi-tenant architecture, identity & access architecture |
| [03-ticketing.md](./03-ticketing.md) | F, G | Ticketing domain, intake channels |
| [04-sla-oncall.md](./04-sla-oncall.md) | H | SLA, escalation, on-call |
| [05-posture-cmdb.md](./05-posture-cmdb.md) | I, J | Posture database, CMDB / asset management |
| [06-notifications-m365.md](./06-notifications-m365.md) | K, L | Notification architecture, Microsoft 365 / Graph / Teams / email |
| [07-automation-kb-reporting.md](./07-automation-kb-reporting.md) | M, N, O | Automation engine, knowledge base, reporting & analytics |
| [08-ai-security-compliance.md](./08-ai-security-compliance.md) | P, Q, R | AI / agent assist, security architecture, compliance architecture |
| [09-data-api-events.md](./09-data-api-events.md) | S, T, U | Data model & schema, API architecture, event-driven architecture |
| [10-stack-ux-ops.md](./10-stack-ux-ops.md) | V, W, X | Technical stack, UX & screens, operating model |
| [11-roadmap-build-test.md](./11-roadmap-build-test.md) | Y, Z, AA | Roadmap, build plan / backlog, test strategy |
| [12-risk-adr-diagrams.md](./12-risk-adr-diagrams.md) | AB, AC, AD | Risk register, ADRs, diagrams |
| [13-competitors.md](./13-competitors.md) | 6 | Competitor & market analysis, differentiation |
| [14-final-deliverables.md](./14-final-deliverables.md) | AE | Deliverables index, open questions, assumptions, validation checklist |
| [workflows/service-desk-workflows.md](./workflows/service-desk-workflows.md) | — | Lite Helpdesk tier model + in-scope request workflows (provisioning, offboarding, password/unlock, group, license, remote support) + ConMon |

## 2. Conventions

### 2.1 Cloud support markings

Every feature that may differ across Microsoft cloud environments is marked with one of:

| Marking | Meaning |
|---------|---------|
| ✅ **Supported** | Confirmed available and used as designed in this cloud |
| 🟡 **Partially supported** | Available with constraints / reduced functionality |
| ❌ **Not supported** | Not available; requires an alternate implementation |
| 🔍 **Requires validation** | Believed available but must be confirmed against current Microsoft documentation / tenant before GA |
| 🔁 **Requires alternate implementation** | A different mechanism must be built for this cloud |

Cloud columns used throughout: **Commercial** (Microsoft Commercial / Azure Commercial), **GCC** (Government Community Cloud), **GCC High**, **AzGov** (Azure Government / DoD where noted).

> **Standing rule:** Do not assume commercial Microsoft Graph, Teams webhooks, SMTP relay, Marketplace apps, or connectors behave identically in GCC High or Azure Government. Anything cloud-dependent is marked 🔍 until validated against the live tenant.

### 2.2 Requirement keywords

`MUST` / `MUST NOT` / `SHOULD` / `MAY` follow RFC 2119 semantics.

### 2.3 Identifiers

- `org_*` — customer organization identifiers
- `nexus_*` — Nexus internal tenant identifiers
- Permission strings use dotted notation: `ticket.read.organization`
- Event names use dotted notation: `ticket.status_changed`

## 3. Glossary

| Term | Definition |
|------|------------|
| **Nexus** | The MSP/CSP operating this platform; its staff are *agents/employees*. |
| **Agent** | Nexus internal employee who services tickets / posture / on-call. |
| **Customer / Customer user** | External user belonging to a supported customer organization. |
| **Organization (org)** | A customer tenant boundary — the primary isolation unit. |
| **Nexus tenant** | The single internal tenant that owns all agents and cross-customer operations. |
| **Posture** | The operational, cloud, security, and compliance state of a customer, tracked as a system of record. |
| **CMDB** | Configuration Management Database — CIs and their relationships. |
| **POA&M** | Plan of Action & Milestones (NIST/FedRAMP remediation tracking). |
| **Data boundary** | The physical/logical region + compliance perimeter a tenant's data must remain within. |
| **Enclave** | A separately deployed government instance with its own data boundary. |
| **CMK / BYOK** | Customer-Managed Key / Bring-Your-Own-Key encryption. |
| **JIT** | Just-In-Time privilege elevation. |
| **RLS** | Row-Level Security. |

## 4. Enterprise-grade definition (used throughout)

"Enterprise-grade" in this spec means the platform demonstrably provides: multi-region HA with stated RPO/RTO, tenant isolation enforced at data and application layers, zero-trust authN/authZ, immutable pervasive audit logging with SIEM export, encryption in transit and at rest with a CMK option, secure SDLC (SAST/DAST/SCA/IaC scanning/SBOM/signed builds), least-privilege RBAC+ABAC, observability (metrics/traces/structured logs/SLOs), idempotent rate-limited APIs, DLQ-backed eventing, documented runbooks, and compliance evidence produced as a natural by-product of operations.

## 5. Government-cloud readiness definition (used throughout)

"Government-cloud ready" means: a single codebase deploys into a **separate government enclave** (Azure Government / GCC High identity authorities and Graph national-cloud endpoints), all cloud-variant integrations resolve through an **integration abstraction layer** governed by a **per-cloud capability matrix and feature flags**, data residency and CUI handling are enforced at the data boundary, and FedRAMP/NIST 800-53/800-171/CMMC control mappings with generated evidence are first-class. No commercial-only dependency may be on the critical path for a government tenant without a marked alternate implementation.

# 01 — Product Foundation (Sections A, B, C)

---

## Section A: Executive Summary

### A.1 Product vision

Nexus is a **multi-tenant, government-cloud-aware ITSM and managed-services operations platform** that lets a single MSP/CSP (Nexus) run a complete enterprise service desk, on-call practice, and **continuous security/compliance posture program** across many external customer organizations spanning commercial, GCC, GCC High, and Azure Government environments — from one operational pane of glass, without ever co-mingling customer data.

The platform unifies three capabilities that the market sells as three separate products:

1. **ITSM / service desk** (tickets, incidents, requests, change, problem, knowledge, CMDB) — competing with ServiceNow / Jira Service Management / Freshservice.
2. **On-call / incident response** (rotations, escalation, paging, major incident bridges) — competing with PagerDuty / Opsgenie / incident.io.
3. **Posture & compliance management** (a system-of-record for each customer's M365/Azure/security/compliance state, findings, exceptions, POA&M, evidence) — competing with GRC and CSPM tooling.

Nexus fuses them so that a **posture finding becomes a ticket**, a ticket can **page on-call**, an on-call action **generates compliance evidence**, and a quarterly business review **assembles itself** from the same operational record.

### A.2 Target users

| Audience | What they get |
|----------|---------------|
| Nexus service desk (Tier 1–3, escalation, on-call) | A cross-customer agent workspace with queues, SLA timers, paging, runbooks |
| Nexus security & compliance analysts | A posture system-of-record, findings → tickets, evidence packages, POA&M tracking |
| Nexus management & executives | Cross-customer health, SLA, workload, and contract-utilization dashboards |
| Customer admins & end users | An isolated, branded portal: submit/track tickets, search KB, view their posture and reports |
| Customer security/compliance/executive/auditor contacts | Read-scoped posture dashboards, compliance evidence, QBR reports |
| Government-sector reviewers | A deployable enclave with FedRAMP/NIST/CMMC-aligned controls and generated evidence |

### A.3 Business justification

- **Margin compression in MSP operations.** Tool sprawl (a PSA + an ITSM + a paging tool + spreadsheets for posture) costs license fees, integration glue, and analyst context-switching. Consolidation reduces per-seat tooling cost and increases agent throughput.
- **Government-sector revenue requires GCC High / Azure Government.** Most off-the-shelf ITSM and on-call SaaS tools are **not authorized or not feature-complete** in GCC High / Azure Government (see [13-competitors.md](./13-competitors.md)). A purpose-built, enclave-deployable platform unlocks CUI-handling and CMMC-bound customers that competitors cannot serve cleanly.
- **Posture-as-a-product.** Continuous posture + compliance evidence is a high-margin managed service. Embedding it in the ticketing system (rather than a bolt-on GRC tool) makes it operationally cheap to deliver and sticky for the customer.
- **Customer retention & expansion.** A branded customer portal with visible posture scores and QBR automation increases stickiness and creates upsell surface (remediation projects, advisory).

### A.4 Strategic differentiation

1. **Single codebase, dual sovereignty.** Commercial and government enclaves from one product, governed by a per-cloud capability matrix — not a forked or third-party-hosted gov variant.
2. **Posture database as a first-class system of record**, natively linked to tickets, SLAs, on-call, and evidence — not a reporting add-on.
3. **MSP-native multi-tenancy** with a Nexus cross-customer operating layer that is *authorized, scoped, and fully audited* — versus single-tenant ITSM tools that bolt on "MSP mode."
4. **Compliance evidence as exhaust.** Evidence (consent records, audit logs, approvals, change records, posture snapshots) is produced by normal operation and packaged on demand.
5. **On-call fused with ITSM and posture.** One severity/SLA model drives both the service desk and paging — no second source of truth.
6. **AI optional, isolated, auditable, off-by-default for sensitive tenants.**

### A.5 Why this should exist / why existing tools fall short

| Need | Why existing tools fall short |
|------|-------------------------------|
| Operate many isolated customer tenants from one console | ServiceNow/Jira/Freshservice are single-tenant per customer or require heavy "domain separation" licensing & engineering; PSA tools (ConnectWise/Autotask) do multi-customer but are weak on government cloud, modern identity, and posture. |
| GCC High / Azure Government deployment with national-cloud Graph endpoints | Most SaaS ITSM/on-call tools are commercial-cloud only or have **no FedRAMP-authorized gov instance**; Teams/Graph/email behave differently and many connectors don't exist there. |
| Posture + compliance evidence as system-of-record tied to tickets | ITSM tools treat security findings as generic tickets; GRC tools are disconnected from operations; CSPM tools don't do ITSM, SLA, or MSP tenancy. |
| Customer identity from *any* tenant (commercial/GCC/GCC High/non-Microsoft) | Most tools assume one IdP per instance; MSP reality is many customer IdPs across clouds plus fallbacks. |
| On-call integrated with SLA & major incident, gov-cloud notification-aware | PagerDuty/Opsgenie are strong but commercial-cloud-centric for SMS/voice/Teams, separate from ITSM, and add another vendor + cost. |

(Full competitor matrix and exploitable gaps: [13-competitors.md](./13-competitors.md).)

### A.6 Enterprise-grade definition

See [README §4](./README.md#4-enterprise-grade-definition-used-throughout). Summarized: multi-region HA (RPO ≤ 5 min, RTO ≤ 1 hr for Tier-1 services), enforced tenant isolation, zero-trust identity, pervasive immutable audit + SIEM export, encryption everywhere with CMK option, secure SDLC with SBOM and signed builds, least-privilege RBAC+ABAC, full observability with SLOs, idempotent rate-limited APIs, DLQ eventing, runbooks, and evidence-by-default.

### A.7 Government-cloud readiness definition

See [README §5](./README.md#5-government-cloud-readiness-definition-used-throughout). Summarized: one codebase, separate gov enclave with gov identity authorities + national-cloud Graph endpoints, integration abstraction layer + per-cloud capability matrix + feature flags, enforced data residency/CUI handling, FedRAMP/NIST/CMMC mappings with generated evidence, no commercial-only critical-path dependency for gov tenants.

### A.8 MSP/CSP-specific differentiation

- **Tenant of tenants.** Nexus is the operator; each customer is an isolated org; agents work *across* orgs only where entitlement assigns them.
- **Entitlement-driven everything.** Support entitlements (contract, severity coverage, business hours, services in scope) drive SLA, routing, and billing utilization.
- **Per-customer branding, KB, workflows, and notification rules** with global inheritance + override.
- **Consolidated cross-customer posture and SLA reporting** for Nexus, but per-customer scoped views for customers.
- **Customer onboarding/offboarding as governed lifecycle** including admin consent capture, data export, and certified deletion.

---

## Section B: Product Principles (non-negotiable)

| # | Principle | What it means in practice | Enforced by |
|---|-----------|---------------------------|-------------|
| P1 | **Tenant isolation by default** | Every query, file, event, cache key, and notification is scoped to one `organization_id`; cross-org access requires an explicit, audited grant. | RLS + app-layer org guard + signed object keys (see [02](./02-architecture.md), [09](./09-data-api-events.md)) |
| P2 | **Customer data minimization** | We collect only what a contracted service requires; posture ingestion pulls scoped Graph data, not mailbox contents; PII is tagged and access-gated. | Data classification, scoped Graph permissions, field-level ABAC |
| P3 | **Auditability** | Every privileged action, data access of sensitive scope, config change, and AI invocation produces an immutable audit record. | Append-only `audit_logs`, WORM storage, SIEM export |
| P4 | **Least privilege** | No standing admin. Cross-customer and destructive permissions are JIT-elevated, time-boxed, and approved. | RBAC+ABAC, JIT elevation, break-glass |
| P5 | **Government-cloud awareness** | No feature ships assuming commercial behavior; cloud variance is explicit and gated. | Capability matrix + feature flags + integration abstraction |
| P6 | **Secure-by-default integrations** | Integrations start with the minimum Graph scopes, certificate/managed-identity auth, no standing secrets where avoidable, and recorded consent. | Integration framework ([06](./06-notifications-m365.md)) |
| P7 | **ITIL-aligned workflows** | Incident/request/problem/change/major-incident follow recognizable ITIL v4 practices so enterprise customers trust the model. | Ticketing domain ([03](./03-ticketing.md)) |
| P8 | **Customer-specific customization without forking** | Per-customer forms, SLAs, workflows, branding, KB inherit from global defaults and override locally; no code forks per customer. | Inheritance/override config model |
| P9 | **Operational simplicity** | One severity model, one SLA engine, one notification bus; complexity lives in config, not in parallel subsystems. | Single domain model |
| P10 | **Human-in-the-loop automation** | Automation proposes; humans approve anything customer-visible, destructive, or risk-accepting. Simulation/test mode before publish. | Automation engine gates ([07](./07-automation-kb-reporting.md)) |
| P11 | **AI optionality** | AI is per-tenant opt-in, off by default for sensitive/gov tenants, never trains cross-tenant, and never emits customer-visible output without approval. | AI module ([08](./08-ai-security-compliance.md)) |
| P12 | **Compliance evidence as a first-class feature** | Evidence is a typed artifact produced by operations and exportable as audit packages; it is not reconstructed after the fact. | Evidence lifecycle ([05](./05-posture-cmdb.md), [08](./08-ai-security-compliance.md)) |

These principles are **acceptance gates**: a feature that violates a principle does not ship without an approved, documented exception recorded in the risk register ([12-risk-adr-diagrams.md](./12-risk-adr-diagrams.md)).

---

## Section C: Personas, Roles, and Permissions

### C.1 Identity model summary

Two disjoint identity planes (detailed in [02-architecture.md](./02-architecture.md)):

- **Nexus plane** — employees/agents authenticate against the **Nexus Entra ID tenant** (commercial *and* a separate gov tenant for the gov enclave). Roles are global-with-customer-scoping.
- **Customer plane** — external users authenticate against **their own IdP** (Entra ID commercial/GCC/GCC High/gov, SAML/OIDC federation, B2B/external identity, magic link, or controlled local fallback). Roles are scoped to a single organization.

A principal is **either** Nexus **or** Customer — never both in one identity. (A Nexus employee who is also a customer of another product uses a separate customer identity.)

### C.2 Nexus (agent/employee) persona table

| Persona | Description | Auth | Default permissions (representative) | Data visibility | Restrictions | Audit |
|---------|-------------|------|--------------------------------------|-----------------|--------------|-------|
| **Nexus Super Admin** | Platform owner; emergency authority | Nexus SSO + MFA + PIM, break-glass exists separately | `admin.superuser` (JIT-gated) | All orgs (JIT) | No standing superuser; all use time-boxed + approved | Every action; alert to security |
| **Nexus Platform Admin** | Configures platform, feature flags, integrations templates | Nexus SSO + MFA + CA | `feature_flag.manage`, `integration.configure`, `notification.template.manage`, `sla.manage` (global) | All orgs metadata; ticket bodies only if assigned | Cannot read customer ticket content org-wide without assignment + reason | All config changes |
| **Service Desk Manager** | Runs the desk; staffing, queues, SLA policy | Nexus SSO + MFA | `ticket.read.all_assigned_customers`, `ticket.assign`, `ticket.merge`, `sla.manage`, `oncall.manage`, `report.read.operational` | Assigned customer set | No `admin.superuser`; no posture write | Assignment/merge/SLA edits |
| **Tier 1 Agent** | First-line triage & resolution | Nexus SSO + MFA | `ticket.create`, `ticket.read.all_assigned_customers`, `ticket.update`, `ticket.comment`, `kb.read` | Assigned customer set | No delete, no escalate-to-exec, no posture write | Ticket edits, comments |
| **Tier 2 Agent** | Deeper troubleshooting | Nexus SSO + MFA | T1 + `ticket.escalate`, `ci.read`, `posture.read` | Assigned customer set | No change approval | As T1 + escalations |
| **Tier 3 Engineer** | Specialist / engineering | Nexus SSO + MFA | T2 + `ci.write`, `automation.author` (draft), `change.implement` | Assigned customer set | No change *approval* (separation of duties) | Changes, CI edits |
| **Escalation Engineer** | Owns escalated/aged tickets | Nexus SSO + MFA | T3 + `ticket.read.all_assigned_customers` broadened, `oncall.page` | Assigned customer set | — | Escalation actions |
| **On-Call Engineer** | Carries the pager | Nexus SSO + MFA, step-up for prod actions | `oncall.acknowledge`, `ticket.update`, `runbook.execute`, `ci.read` | Active incident scope | Scoped to active page unless otherwise entitled | Ack, runbook exec |
| **Incident Commander** | Runs major incidents | Nexus SSO + MFA | `mim.declare`, `mim.manage`, `oncall.page`, `ticket.escalate`, `notification.broadcast` | Affected orgs during incident | — | MIM lifecycle |
| **Change Manager** | CAB authority | Nexus SSO + MFA | `change.approve`, `change.schedule`, `cab.manage` | Assigned customer set | Cannot *implement* changes they approve | Approvals, schedule |
| **Problem Manager** | Root cause / known error | Nexus SSO + MFA | `problem.manage`, `kb.author`, `ticket.link` | Assigned customer set | — | Problem records |
| **Security Analyst** | Posture & security events | Nexus SSO + MFA + step-up | `posture.read`, `posture.write`, `posture.finding.manage`, `ticket.create`, `siem.read` | Assigned customer set | Cannot approve own risk exceptions | Posture writes, evidence |
| **Compliance Analyst** | Frameworks, evidence, POA&M | Nexus SSO + MFA | `posture.read`, `compliance.export`, `poam.manage`, `evidence.manage`, `audit.read` | Assigned customer set | No posture finding closure without analyst sign-off | Evidence export, POA&M |
| **Customer Success Manager** | Owns customer relationship | Nexus SSO + MFA | `ticket.read.all_assigned_customers`, `report.read.customer`, `posture.read`, `contract.read` | Assigned customer set | No posture/ticket write | Report exports |
| **Auditor (Nexus)** | Internal/external audit | Nexus SSO + MFA | `audit.read`, `compliance.export`, `posture.read` (read-only everything in scope) | Scoped, read-only | No write anywhere | Read access logged |
| **Read-only Executive Viewer** | Nexus leadership dashboards | Nexus SSO + MFA | `report.read.executive` | Aggregated cross-customer (no raw ticket bodies by default) | Read-only | Dashboard access |

**Posture-DB capabilities** by Nexus persona: Security Analyst (write/findings), Compliance Analyst (evidence/POA&M/export), Tier 2/3 (read), CSM/Exec (read/aggregate), Auditor (read). **Reporting**: Manager/CSM (customer + operational), Exec (executive aggregate), Auditor/Compliance (evidence). **Admin**: only Platform/Super Admin (and Service Desk Manager for desk config).

### C.3 Customer (external user) persona table

| Persona | Description | Auth | Default permissions | Data visibility | Ticket capabilities | Posture capabilities | Reporting | Admin | Restrictions | Audit |
|---------|-------------|------|---------------------|-----------------|---------------------|----------------------|-----------|-------|--------------|-------|
| **Customer Org Admin** | Manages their org's users & settings | Their IdP SSO (or controlled fallback) | `customer.admin.manage_users`, `ticket.read.organization`, `integration.configure` (own org), `report.read.customer` | Own org only | Read all org tickets, comment, approve | `posture.read` (own org) | Customer dashboards & QBR | Manage own org users/roles, branding, notification rules | Cannot see other orgs; cannot write posture | User mgmt, integration consent |
| **Customer End User** | Submits & tracks own requests | IdP SSO / magic link | `ticket.create`, `ticket.read.own`, `ticket.comment.own`, `kb.read.customer` | Own tickets only | Create, comment, satisfaction rating | None | None | None | Cannot see others' tickets in org | Own actions |
| **Customer Manager / Approver** | Approves requests | IdP SSO | End user + `approval.act` | Own tickets + approvals routed to them | + approve/reject requests | None | Team-level (optional) | None | Scope to assigned approvals | Approvals |
| **Customer Technical Contact** | Coordinates technical issues | IdP SSO | `ticket.read.organization` (optionally), `ticket.comment`, `ci.read.own_org` | Own org tickets/CIs | Comment, create, link CIs | `posture.read` (optional) | Operational (optional) | None | — | Actions |
| **Customer Security Contact** | Receives security/posture info | IdP SSO + MFA recommended | `posture.read`, `ticket.read.organization` (security-tagged), `report.read.security` | Own org posture + security tickets | Comment on security tickets | `posture.read`, request exception | Security & posture reports | None | Cannot approve own exceptions org-side | Posture views, exception requests |
| **Customer Billing / Contract Contact** | Contract & entitlement | IdP SSO | `contract.read`, `report.read.utilization` | Own org contract/entitlement | View billing-support tickets | None | Utilization | None | No technical ticket bodies by default | Views |
| **Customer Auditor** | Customer-side audit | IdP SSO | `audit.read.own_org`, `compliance.read`, `posture.read` | Own org, read-only | Read-only | Read posture + evidence | Evidence/QBR | None | Read-only | Access logged |
| **Customer Executive Viewer** | Customer leadership | IdP SSO | `report.read.customer_exec`, `posture.read` (score) | Own org aggregate | None | Posture score/trend | Exec summary | None | No raw tickets | Dashboard access |

### C.4 RBAC + ABAC model

**Design choice:** RBAC for coarse capability, **ABAC for scope and conditions** — recommended because pure RBAC explodes into per-customer role copies in an MSP, while pure ABAC is hard to reason about. We combine them: a **role** grants permission *verbs*; **attributes** constrain the *resource scope and conditions*.

```
Effective permission = Role grants (verbs)  ∩  ABAC policy (scope + conditions)  ∩  Cloud capability  ∩  JIT/elevation state
```

**Attributes** used by ABAC policies:

| Attribute | Source | Example use |
|-----------|--------|-------------|
| `principal.plane` | identity (`nexus` \| `customer`) | Customers can never receive cross-org scope |
| `principal.assigned_customers[]` | role_assignments | Agent sees only assigned orgs |
| `principal.elevation` | JIT state | Destructive/cross-customer verbs require active elevation |
| `resource.organization_id` | resource | Must ∈ assigned_customers (agent) or == principal.org (customer) |
| `resource.classification` | data tag (`public`/`internal`/`cui`/`pii`) | CUI fields need step-up + cleared role |
| `resource.security_tagged` | ticket tag | Only security contacts/analysts see security-tagged tickets |
| `env.cloud` | tenant cloud | Feature gated by capability matrix |
| `time.business_hours` | calendar | Some actions restricted to windows |

**Policy evaluation:** deny-by-default; a request is allowed only if (a) the role grants the verb, (b) every applicable ABAC policy returns `permit`, and (c) cloud capability permits. Decisions are logged for sensitive scopes. Policies are authored as data (see `policies` concept) and evaluated by a central PDP (Policy Decision Point) called from every API ([09](./09-data-api-events.md), [Section T](./09-data-api-events.md)).

**Example ABAC policy (pseudocode):**

```text
policy ticket_read:
  permit if principal.plane == "nexus"
    and verb in {"ticket.read.all_assigned_customers"}
    and resource.organization_id in principal.assigned_customers
    and (resource.security_tagged == false
         or principal.role in {"SecurityAnalyst","Tier2","Tier3","IncidentCommander"})
  permit if principal.plane == "customer"
    and resource.organization_id == principal.organization_id
    and ( (verb == "ticket.read.own"  and resource.requester_id == principal.id)
        or (verb == "ticket.read.organization" and principal.role in {"OrgAdmin","TechnicalContact","SecurityContact","Auditor"}
             and (resource.security_tagged == false or principal.role in {"SecurityContact","Auditor","OrgAdmin"})) )
  deny otherwise
```

### C.5 Canonical permission catalog

Grouped; this is the authoritative verb list (extended per module in later sections).

| Domain | Permissions |
|--------|-------------|
| Ticket | `ticket.create`, `ticket.read.own`, `ticket.read.organization`, `ticket.read.all_assigned_customers`, `ticket.update`, `ticket.assign`, `ticket.escalate`, `ticket.merge`, `ticket.comment`, `ticket.comment.own`, `ticket.delete.restricted`, `ticket.link`, `ticket.reopen` |
| Posture | `posture.read`, `posture.write`, `posture.finding.manage`, `posture.approve_exception`, `posture.request_exception`, `evidence.manage`, `poam.manage` |
| Customer admin | `customer.admin.manage_users`, `customer.admin.manage_roles`, `customer.admin.branding`, `customer.admin.notification_rules` |
| Integration | `integration.configure`, `integration.test`, `integration.read_health` |
| SLA / on-call | `sla.manage`, `oncall.manage`, `oncall.acknowledge`, `oncall.page`, `oncall.override` |
| Change / problem / MIM | `change.implement`, `change.approve`, `change.schedule`, `cab.manage`, `problem.manage`, `mim.declare`, `mim.manage` |
| Knowledge | `kb.read`, `kb.read.customer`, `kb.author`, `kb.publish`, `kb.review` |
| Automation | `automation.author`, `automation.publish`, `automation.execute_manual` |
| Audit / compliance | `audit.read`, `compliance.export`, `compliance.read` |
| Reporting | `report.read.operational`, `report.read.customer`, `report.read.customer_exec`, `report.read.executive`, `report.read.security`, `report.read.utilization`, `report.build` |
| CMDB | `ci.read`, `ci.write`, `ci.relate`, `asset.manage` |
| Platform admin | `feature_flag.manage`, `notification.template.manage`, `notification.broadcast`, `admin.superuser` |

**Separation-of-duties constraints (enforced):** `change.implement` ⊻ `change.approve` for the same change; `posture.write` person ≠ `posture.approve_exception` approver; `automation.author` ≠ `automation.publish` for the same version in sensitive tenants; `admin.superuser` is JIT-only with secondary approval.

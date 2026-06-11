# 10 — Technical Stack, UX & Operating Model (Sections V, W, X)

---

## Section V: Recommended Technical Stack

### V.1 Cross-cutting choices

| Concern | Choice | Why |
|---------|--------|-----|
| Language (backend) | TypeScript (Node) + selective Go for hot paths (SLA sweeper, event workers) | Shared types with frontend; Go for low-latency timers |
| API | NestJS (or Fastify) REST + OpenAPI generation | Structure, DI, guards map cleanly to PDP |
| Frontend | React + TypeScript + Next.js (app router) | SSR for portals, RSC for performance, mature ecosystem |
| UI components | **Tailwind CSS + shadcn/ui foundation, composed with [21st.dev community components](https://21st.dev/community/components)** | See V.2 / [Section W](#section-w-ux--screen-specifications) |
| DB | PostgreSQL (Azure Database for PostgreSQL Flexible Server) | RLS, jsonb, partitioning, mature |
| Cache | Redis (Azure Cache for Redis) | Sessions, rate limits, hot lookups |
| Eventing | Azure Service Bus + Event Grid | Ordering, DLQ, gov parity |
| Object storage | Azure Blob (immutable/WORM tier for evidence/audit) | Evidence integrity |
| Secrets/keys | Azure Key Vault / Managed HSM, Managed Identity | Secretless, CMK |
| IaC | Bicep (Azure-native) or Terraform | Repeatable enclaves |
| CI/CD | GitHub Actions or Azure DevOps; signed builds, SBOM | Secure SDLC |
| Observability | Application Insights + Log Analytics + OpenTelemetry traces | SLO/SLI |
| SIEM | Microsoft Sentinel (per cloud) | Gov parity |

### V.2 Frontend component strategy — 21st.dev

The UI is built on **Tailwind + shadcn/ui primitives**, with **[21st.dev community components](https://21st.dev/community/components)** used as an accelerated library of higher-level, production-styled React/Tailwind building blocks (dashboards, data tables, command palettes, kanban/queue boards, file dropzones, charts, timelines, multi-step forms, navigation shells, empty/loading states). Rationale and governance:

| Aspect | Decision |
|--------|----------|
| Why 21st.dev | Components are shadcn-compatible, copy-in (source lives in our repo — **no runtime third-party dependency**, critical for gov enclaves with restricted egress), Tailwind-themeable for per-tenant branding, and accelerate building the ~35 screens in [Section W](#section-w-ux--screen-specifications). |
| Integration model | **Vendor-in (copy source), do not CDN-load.** Each adopted component is pulled into `packages/ui/`, code-reviewed, dependency-scanned (SCA), and license-checked before use — it becomes first-party code under our SDLC ([08 §Q.4](./08-ai-security-compliance.md)). |
| Gov-cloud constraint | Government enclaves must not fetch components/assets at runtime from external services. Because 21st.dev components are copied into our repo and bundled, this is satisfied. Any component pulling external fonts/icons/telemetry is patched to local assets before adoption. |
| Theming / branding | Tailwind CSS variables drive per-tenant branding (logo, palette) for the customer portal (principle P8); 21st.dev components consume the theme tokens. |
| Accessibility | Components selected/patched to meet WCAG 2.1 AA + Section 508 (required for gov); audited in CI (axe) — see [Section AA](./11-roadmap-build-test.md). |
| Candidate components → screens | data-table/queue + filters → Agent Queue/Triage; kanban board → on-call/MIM; dashboard cards + charts → posture & exec dashboards; command palette → agent workspace; multi-step form/wizard → Submit Ticket / onboarding; file dropzone → attachments/evidence; timeline → ticket events/PIR; nav shell/sidebar → app shells. |
| Maintenance | Adopted components are pinned by copied version; updates are deliberate PRs (not auto-pull) to keep the gov bundle reproducible and auditable. |

> **Net:** 21st.dev accelerates UI delivery without introducing a runtime third-party dependency or egress requirement — it is treated as a curated source library vendored into our codebase and governed like any first-party code.

### V.3 Commercial SaaS deployment (Azure Commercial)

| Layer | Service |
|-------|---------|
| Edge | Azure Front Door + WAF + DDoS Protection |
| Compute | AKS (primary) or App Service; containerized; HPA autoscale |
| Data | Azure Database for PostgreSQL Flexible Server (HA, zone-redundant, PITR) |
| Cache | Azure Cache for Redis |
| Messaging | Service Bus (Premium) + Event Grid |
| Storage | Blob (immutable tier for evidence/audit) |
| Secrets/keys | Key Vault + Managed HSM; Managed Identity; CMK option |
| Observability | App Insights + Log Analytics + Sentinel |
| Network | VNet, Private Endpoints (DB/Redis/Blob/KV/Bus), no public data-plane |
| IaC/CD | Bicep/Terraform; GitHub Actions; blue/green + canary; gated DB migrations (expand-contract) |

### V.4 Government deployment (Azure Government / GCC High)

| Layer | Gov equivalent / note |
|-------|------------------------|
| Region | Azure Government regions only; gov data boundary enforced |
| Identity | Gov Entra authorities (`login.microsoftonline.us`), national-cloud Graph (`graph.microsoft.us`) — 🔍 validate |
| Compute/Data/Msg | Same Azure services, Azure Government editions; verify each service is **FedRAMP High / IL-authorized** in region (🔍) |
| Logging | FedRAMP-aligned logging → Sentinel in Azure Government; logs never leave enclave |
| Integration matrix | Restricted feature set from [06](./06-notifications-m365.md); Teams/SMS/AI gated/disabled until validated |
| Deployment | **Separate subscription/tenant + separate pipeline**; promotion model commercial→gov is artifact-promotion with gov-side approval + change control |
| Evidence | Consent records, change records, audit exports captured for ATO package |
| AI | GovCloud-compatible model deployment or disabled ([08 §P.1](./08-ai-security-compliance.md)) |

**Deployment separation:** commercial and government are **independent deployments** (separate IaC state, subscriptions, pipelines, data planes). One codebase, two enclaves, config-driven differences via `cloud_environments` + `feature_flags`.

### V.5 Containerized portable option

Fully containerized (OCI images, Helm charts, Postgres/Redis/NATS-or-ServiceBus-emulation, S3-compatible blob) to deploy into other clouds or customer-sovereign environments. Cloud-specific services are behind interfaces (storage, bus, secrets, identity, Graph) so the portable build swaps implementations without app changes — supports air-gapped/sovereign customers.

### V.6 Migration & release strategy

- **DB migrations:** expand-contract (add nullable → backfill → switch → drop) so deploys are zero-downtime and reversible; migrations gated + reviewed; applied per enclave.
- **Releases:** trunk-based + feature flags; blue/green for app tier; canary for risky changes; gov releases follow change-control with CAB approval.

---

## Section W: UX & Screen Specifications

### W.1 Design system & shells

- **Three app shells:** Customer Portal (branded, simplified), Nexus Agent Workspace (dense, keyboard-driven, command palette), Admin Console.
- Built from [21st.dev](https://21st.dev/community/components) + shadcn components (V.2); responsive; dark/light; WCAG 2.1 AA + Section 508.
- **Global UX rules:** every list = filter + sort + saved views + bulk actions where permitted; every screen has explicit **empty, loading, and error** states; destructive/customer-visible actions confirm; permission-aware rendering (hide/disable unauthorized actions, never rely on hiding alone — server enforces).

### W.2 Screen catalog

Format per screen: **Purpose · Roles · Key fields · Actions · Filters/Sort · Bulk · Permission behavior · Empty/Error · Audit · A11y**. (Condensed; all 35 screens covered.)

| # | Screen | Purpose | Roles | Key actions / fields | Filters/Bulk | Audit / notes |
|---|--------|---------|-------|----------------------|--------------|---------------|
| 1 | **Login** | Authenticate | all | email entry → IdP redirect | — | auth events; A11y: labeled inputs, focus order |
| 2 | **IdP selection** | Choose IdP/fallback | all | pick org IdP / magic link / local | — | resolver logged |
| 3 | **Customer portal dashboard** | Customer home | customer roles | my tickets, posture grade, announcements, KB search | status filter | branded; empty=onboarding hints |
| 4 | **Submit ticket** | Create request | end user+ | dynamic form by type/category, attachments (dropzone, scanned), KB deflection | — | `ticket.created`; validation errors inline |
| 5 | **Ticket detail** | View/work ticket | customer (own/org) + agents | timeline, fields, SLA badges, links | — | every change → `ticket_events` |
| 6 | **Ticket comments** | Converse | requester/org/agents | add comment; internal notes hidden from customer | — | visibility enforced server-side |
| 7 | **Ticket attachments** | Files | per ticket scope | upload (scanned), download (scoped URL) | — | malware scan; access logged |
| 8 | **Ticket approval** | Approve requests | approver | approve/reject + reason | queue filter; bulk approve | `approval.*` |
| 9 | **Customer KB search** | Self-service | customer | search, article view, feedback | tag filter | deflection tracked |
| 10 | **Customer posture dashboard** | Posture view | customer admin/security/exec/auditor | score, domains, trend, findings (read), request exception | severity filter | read-only; `posture.read` |
| 11 | **Customer reports** | Reports/QBR | customer admin/exec/auditor | view/export SLA, CSAT, QBR | period | export audited |
| 12 | **Customer admin user mgmt** | Manage users | customer org admin | invite/disable, assign roles | bulk role | `customer.admin.manage_users` |
| 13 | **Customer integration setup** | Connect M365 | customer org admin | admin-consent flow, test button, health | — | consent evidence captured |
| 14 | **Nexus agent queue** | Work intake | agents | queue (data-table), claim, assign, bulk update | rich filters; saved views; bulk assign/tag | scope = assigned orgs |
| 15 | **Agent ticket workspace** | Resolve | agents | split view: ticket + KB + CIs + posture; command palette | — | dense, keyboard-first |
| 16 | **Triage console** | Classify/route | T1/lead | suggested (AI) priority/category/group, accept/override | unassigned filter; bulk route | AI suggestions logged, agent confirms |
| 17 | **SLA console** | SLA health | manager | at-risk/breached timers, reassign | severity/customer filter | breach actions audited |
| 18 | **On-call console** | Paging/rotation | on-call/manager/IC | active pages, ack, schedule board (kanban), overrides/swaps | — | acks audited |
| 19 | **Major incident console** | Run MIM | IC | declare, bridge link, comms cadence, timeline | — | `mim.*`; comms logged |
| 20 | **Change mgmt console** | Changes/CAB | change mgr/T3 | request, schedule, approve (SoD), calendar | window filter | approver≠implementer enforced |
| 21 | **Problem mgmt console** | RCA/known error | problem mgr | problems, linked incidents, known-error KB | — | `problem.manage` |
| 22 | **Posture DB dashboard** | Fleet posture | Nexus security/compliance/CSM | cross-customer scores, worst-N, finding aging, ingestion health | customer/severity filter | scope = assigned; gov stays in enclave |
| 23 | **Posture finding detail** | Work finding | security/compliance | risk, evidence, linked ticket, remediation plan, exception | — | writes audited; SoD on exceptions |
| 24 | **Posture evidence upload** | Capture evidence | compliance | dropzone, type tag, hash, link | — | immutable, hashed |
| 25 | **Asset/CMDB explorer** | CIs & relations | agents/security | CI graph, dependencies, linked tickets | class/criticality filter | edits audited |
| 26 | **KB admin** | Author KB | authors/reviewers | draft/review/publish, versions, expiry | scope filter; bulk archive | lifecycle audited |
| 27 | **Automation builder** | Build workflows | platform admin/authors | rule + visual builder, simulate, publish/rollback | — | author≠publisher (sensitive) |
| 28 | **Report builder** | Build reports | manager/analyst | fields/filters/group, schedule, export | — | exports audited |
| 29 | **Integration health dashboard** | Ops health | platform admin/ops | per-integration status, token/subscription expiry, errors, test | cloud/customer filter | failures alert |
| 30 | **Audit log viewer** | Review audit | auditor/compliance/admin | scoped search, export | actor/action/time filter | read access logged; immutable source |
| 31 | **Admin settings** | Platform/org config | admins | branding, SLA defaults, notification rules, calendars | — | config changes audited |
| 32 | **Feature flag management** | Per-cloud/tenant flags | platform admin | toggle capabilities, AI enable, per-cloud matrix view | cloud filter | flag changes audited |
| 33 | **Service catalog admin** | Manage catalog | admin | catalog items, forms, fulfillment | — | audited |
| 34 | **Notification preference center** | User prefs | all users | channels, quiet hours, digest | — | self-service |
| 35 | **Tenant onboarding wizard** | Onboard customer | Nexus admin/CSM | multi-step: org→IdP→consent→entitlements→integrations→go-live | — | each step → evidence |

### W.3 Accessibility (applies to all)

WCAG 2.1 AA + Section 508 (mandatory for gov): keyboard operability, visible focus, ARIA roles/labels, color-contrast ≥ 4.5:1, screen-reader-tested data tables, reduced-motion support, error identification by text not color alone. Audited via automated (axe) + manual passes ([Section AA](./11-roadmap-build-test.md)).

---

## Section X: Operating Model

### X.1 Support team structure

| Layer | Group | Responsibility |
|-------|-------|----------------|
| Tier 1 | Service Desk | Triage, known fixes, request fulfillment |
| Tier 2 | Specialists | Deeper troubleshooting, escalations |
| Tier 3 | Engineering | Complex/root-cause, change implementation |
| Escalation | Escalation engineers | Aged/breaching tickets |
| On-call | Rotation | After-hours Sev1/2, paging |
| Security/Compliance | Analysts | Posture, findings, evidence, POA&M |
| Major Incident | Incident Commanders | Run major incidents |
| CAB | Change managers + stakeholders | Approve changes |
| Customer Success | CSMs | Relationship, QBR, health |

**Assignment groups** map to services/customers; routing rules ([03](./03-ticketing.md)) direct tickets; **tier/escalation model** per [04](./04-sla-oncall.md).

### X.2 Core processes

| Process | Summary |
|---------|---------|
| On-call operating procedure | Rotation handoff checklist, ack SLAs, escalation chain, fatigue limits ([04](./04-sla-oncall.md)) |
| Major incident process | Declare → IC → bridge → comms cadence → resolve → PIR → problem/changes ([04 §H.10](./04-sla-oncall.md)) |
| Change process | Request → risk/impact (CMDB blast radius) → CAB approval (SoD) → schedule → implement → verify → close |
| Problem management | Recurring incidents → problem → RCA → known error → permanent fix/change |
| Customer onboarding | Wizard ([W.2 #35](#w2-screen-catalog)); identity, consent, entitlements, integrations, posture seed, go-live sign-off |
| Customer offboarding | Freeze → export → retention → certified deletion + certificate ([02 §D.8](./02-architecture.md)) |
| Integration onboarding | Admin consent, least scopes, test, health monitor, evidence |
| SLA policy onboarding | Map contract → policies/calendars/entitlements |
| Posture review cadence | Per-profile cadence; analyst review; findings; QBR feed |
| QBR reporting | Quarterly auto-assembled package + CSM review |
| Audit review | Periodic access reviews, evidence completeness checks |
| Security incident response | IR plan; SIEM-driven; break-glass review; customer/regulator comms |
| Backup restore testing | Quarterly restore drill with evidence |
| DR testing | Scheduled failover exercise per enclave |
| Production release | Trunk + flags, blue/green/canary, gov via CAB |
| CAB model | Standard/normal/emergency change classes; emergency post-review |
| Runbooks | Versioned, linked to CIs/services/findings; executed + logged |

### X.3 RACI (excerpt)

| Activity | T1 | T2/T3 | On-call | IC | Change Mgr | Security/Compliance | CSM | Platform Admin |
|----------|----|-------|---------|----|------------|---------------------|-----|----------------|
| Triage ticket | R | C | — | — | — | — | I | — |
| Resolve incident | R/A | R | C | — | — | — | I | — |
| Declare major incident | — | C | C | A/R | I | C | I | I |
| Approve change | — | C | — | I | A/R | C | I | I |
| Implement change | — | R | C | — | I | — | — | C |
| Manage posture finding | — | C | — | — | — | A/R | I | — |
| Approve risk exception | — | — | — | — | C | A (≠ requester) | I | I |
| Customer offboarding | — | C | — | — | — | C | R | A |

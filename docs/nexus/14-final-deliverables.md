# 14 — Final Deliverables (Section AE)

This section maps each required deliverable to where it lives, then provides the cross-cutting Open Questions, Assumptions, and Validation Checklist.

## AE.1 Deliverables index

| # | Deliverable | Location |
|---|-------------|----------|
| 1 | Product Requirements Document (PRD) | [01-foundation.md](./01-foundation.md) (A–C) + [03](./03-ticketing.md), [04](./04-sla-oncall.md), [05](./05-posture-cmdb.md), [07](./07-automation-kb-reporting.md) domain sections |
| 2 | Technical Architecture Document | [02-architecture.md](./02-architecture.md), [09-data-api-events.md](./09-data-api-events.md), [10-stack-ux-ops.md](./10-stack-ux-ops.md) (V) |
| 3 | Security Architecture Document | [08-ai-security-compliance.md](./08-ai-security-compliance.md) (Q) |
| 4 | Compliance Architecture Document | [08-ai-security-compliance.md](./08-ai-security-compliance.md) (R) |
| 5 | Data Model | [09-data-api-events.md](./09-data-api-events.md) (S) |
| 6 | API Specification | [09-data-api-events.md](./09-data-api-events.md) (T) |
| 7 | Event Catalog | [09-data-api-events.md](./09-data-api-events.md) (U) |
| 8 | UX Screen Inventory | [10-stack-ux-ops.md](./10-stack-ux-ops.md) (W) |
| 9 | User Story Backlog (75) | [11-roadmap-build-test.md](./11-roadmap-build-test.md) (Z.3) |
| 10 | Test Plan | [11-roadmap-build-test.md](./11-roadmap-build-test.md) (AA) |
| 11 | Risk Register | [12-risk-adr-diagrams.md](./12-risk-adr-diagrams.md) (AB) |
| 12 | ADR Set (16) | [12-risk-adr-diagrams.md](./12-risk-adr-diagrams.md) (AC) |
| 13 | MVP Scope | [11-roadmap-build-test.md](./11-roadmap-build-test.md) (Y.1) |
| 14 | Enterprise v1 Scope | [11-roadmap-build-test.md](./11-roadmap-build-test.md) (Y.2) |
| 15 | Government-ready v1 Scope | [11-roadmap-build-test.md](./11-roadmap-build-test.md) (Y.3) |
| 16 | Open Questions | AE.2 below |
| 17 | Assumptions | AE.3 below |
| 18 | Validation Checklist | AE.4 below |

Supporting: [Competitor analysis](./13-competitors.md) (§6), [Notifications/M365](./06-notifications-m365.md) (K–L), [Diagrams](./12-risk-adr-diagrams.md) (AD).

## AE.2 Open questions

| # | Question | Owner | Blocks |
|---|----------|-------|--------|
| OQ-01 | Which exact Azure services are FedRAMP High / IL4-IL5 authorized in target Azure Government regions today? (🔍 verify each) | Gov Architect | Gov v1 service selection |
| OQ-02 | Is Azure OpenAI (or any authorized LLM) available + authorized in the target gov enclave? If not, AI stays disabled in gov. | AI Lead | AI in gov |
| OQ-03 | Confirm current Teams notification mechanism support (Graph channel post / Workflows / bot) per GCC/GCC High/AzGov. | Notif Lead | Teams in gov |
| OQ-04 | Confirm email send path in GCC High / AzGov (Graph Mail.Send vs authorized relay) and inbound mail-flow options. | Integration Lead | Gov email/intake |
| OQ-05 | Cross-cloud B2B/External ID support (commercial↔GCC High) for customers without their own gov IdP — feasible or local fallback only? | Identity Lead | Customer auth in gov |
| OQ-06 | FedRAMP path: pursue Nexus's own ATO vs leverage a sponsoring agency vs inherit from Azure Gov controls — and Moderate vs High target. | Exec Sponsor | Gov go-to-market |
| OQ-07 | Default data-residency regions per enclave and per-customer override policy. | Gov Architect | Provisioning |
| OQ-08 | Billing/PSA strategy — build light vs integrate ConnectWise/Autotask for contract+invoicing. | Product | Contract module scope |
| OQ-09 | Per-tenant dedicated-DB threshold criteria (which customers auto-qualify). | Architect | Isolation tier policy |
| OQ-10 | Customer SIEM export contract: which formats/connectors (CEF/Syslog/Graph Security API) customers require. | Security | SIEM integration scope |
| OQ-11 | Mobile scope (native vs PWA) and gov push feasibility. | Product | V2 mobile |
| OQ-12 | SMS/voice provider with gov authorization for on-call (or restrict gov paging to email/push). | SRE Lead | Gov on-call channels |
| OQ-13 | 21st.dev component licensing terms per adopted component — confirm each is compatible with vendoring into a proprietary product. | Eng Lead | UI library adoption |

## AE.3 Assumptions

| # | Assumption |
|---|------------|
| AS-01 | Nexus operates its own Entra ID tenant(s) — separate commercial and government tenants. |
| AS-02 | Most customers are Microsoft 365-centric (commercial/GCC/GCC High/gov), with a minority non-Microsoft (handled via SAML/OIDC). |
| AS-03 | Azure is the primary cloud for both enclaves; a portable container build covers sovereign/air-gapped exceptions. |
| AS-04 | Government customers are provisioned only in the government enclave; gov data never transits the commercial enclave. |
| AS-05 | Customers will grant scoped admin consent for posture/integration capabilities (least privilege, certificate-credentialed). |
| AS-06 | Nexus is a data processor/custodian; customers own their data (drives export/deletion/legal-hold rights). |
| AS-07 | Microsoft national-cloud endpoint behaviors must be validated per tenant at onboarding (nothing gov-related is assumed). |
| AS-08 | AI is off by default for sensitive/gov tenants and requires contractual approval to enable. |
| AS-09 | Target SLOs: RPO ≤ 5 min, RTO ≤ 1 hr for Tier-1 services; refined per contract. |
| AS-10 | Compliance scope per customer is contractually defined (NIST/CMMC/FedRAMP/SOC2/etc.) — not all frameworks apply to all customers. |
| AS-11 | 21st.dev components are vendored (copied into the repo) and governed as first-party code; no runtime third-party fetch, satisfying gov egress constraints. |

## AE.4 Validation checklist (pre-GA, per enclave)

**Isolation & identity**
- [ ] Tenant-isolation suite green (read/write/cache/blob/notify) — blocking
- [ ] RLS + app org-guard fail-closed verified on every tenant-scoped table
- [ ] RBAC/ABAC permission matrix fully covered; deny-by-default proven
- [ ] Object-level authZ (IDOR) tests pass on all resource fetches
- [ ] Token validation (issuer/audience/sig/exp/tenant) verified across all supported IdPs and cloud authorities
- [ ] JIT elevation + break-glass monitored with alerts; step-up enforced on sensitive verbs

**Government cloud**
- [ ] Per-cloud endpoints sourced from `cloud_environments` (no hardcoded commercial endpoints) — verified
- [ ] Gov enclave deploys from same codebase via separate pipeline
- [ ] No-egress test: gov data (incl. AI/Teams/email paths) never leaves enclave — verified
- [ ] Capability matrix correct per cloud; unsupported features gated + fallback logged
- [ ] Each gov-cloud Azure service confirmed authorized in region (OQ-01)
- [ ] Gov email + Teams strategy validated live (OQ-03/04); portal floor functional

**Security**
- [ ] TLS 1.2+, WAF, rate limiting active; SSRF/CSRF/XSS/SQLi protections tested
- [ ] Attachments scanned before availability; served via scoped URLs
- [ ] Secrets only in Key Vault; managed identities/certs used; secret-scan clean
- [ ] SAST/DAST/SCA/IaC/container scans gating; SBOM generated; builds signed
- [ ] Audit logs immutable + hash-chained + SIEM export verified
- [ ] Per-tenant key hierarchy; CMK revocation path tested for opted tenants
- [ ] Pen test completed; high/critical findings remediated

**Reliability & data**
- [ ] Multi-AZ HA; multi-region DR failover demonstrated within RTO/RPO
- [ ] Backup restore (incl. per-tenant) tested with evidence
- [ ] Offboarding export + certified deletion (crypto-erase) + certificate produced
- [ ] Legal hold blocks deletion; eDiscovery export scoped + logged

**Domain correctness**
- [ ] SLA calc verified across calendars/DST/pause-resume; warning/breach idempotent
- [ ] On-call no-ack escalation, fatigue controls, overrides verified
- [ ] Notification routing + fallback chain + retry/DLQ verified
- [ ] Posture finding → ticket → SLA → evidence loop verified end-to-end
- [ ] Automation simulation→publish→rollback with permission boundaries + audit verified

**Compliance & UX**
- [ ] Evidence generated for AC/AU/CM/CP/IR/RA/SC/SI controls; audit package exports
- [ ] Framework crosswalks (NIST 800-53/171, CMMC, FedRAMP) reviewed by compliance
- [ ] WCAG 2.1 AA + Section 508 audited (automated + manual)
- [ ] 21st.dev components vendored, SCA/license-checked, no external runtime fetch (OQ-13/AS-11)

**Operational readiness**
- [ ] Runbooks for on-call, MIM, change, onboarding/offboarding, DR, integration failure
- [ ] Observability: SLOs/SLIs, dashboards, synthetic monitoring, health checks live
- [ ] Production-readiness review signed off per enclave

---

## AE.5 Production-readiness checklist (condensed gate)

A release to an enclave is GA-eligible only when: isolation + identity + security + reliability + domain-correctness + compliance + operational sections above are all green for that enclave, the risk register has no open **High** without an accepted mitigation, and all blocking CI gates ([11 §AA.3](./11-roadmap-build-test.md)) pass.

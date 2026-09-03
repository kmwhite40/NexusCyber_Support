# NexusCyber — Competitive Gap Analysis & Enterprise Roadmap

**Date:** 2026-06-12
**Positioning:** "Cyber operations control plane" — ITSM + on-call/incident response + continuous security posture, multi-tenant, Commercial **and** Azure Government.

## Current capability baseline (audited)

37 API modules / 24 web routes / 37 migrations / 64 test files. Already implemented: tickets (types, SLA, links, merge, bulk, canned responses, participants/@mentions, worklogs, configurable workflows, request forms), service catalog, knowledge base, queues, change & problem management, on-call (schedules/rotations/overrides/pages/ack/escalate-one-step), **alerts** (dedup, triggered→ack→resolved, escalate→ticket+page), channels, posture (findings/exceptions/scoring), compliance controls + coverage, continuous monitoring (conmon), CMDB (services + CIs), audit (hash-chained), automation rules + gated approvals, analytics, named dashboards, customers/orgs, notifications (+templates/recipients), attachments (scan), CSAT, JIT elevation/break-glass, announcements, M365 integration. RBAC + ABAC, RLS tenant isolation, dual Commercial/Gov deploy.

This is already at or near **Jira Service Management** parity for ITSM and **basic Opsgenie** parity for on-call.

## Competitive comparison

| Capability area | ServiceNow | Jira SM + Opsgenie | Freshservice | PagerDuty | Vanta/Drata | **Nexus today** |
|---|---|---|---|---|---|---|
| Core ITSM (incident/request/change/problem) | ✅ | ✅ | ✅ | — | — | ✅ |
| SLA engine + calendars + pause | ✅ | ✅ | ✅ | — | — | ✅ |
| Knowledge base + deflection | ✅ | ✅ | ✅ | — | — | ✅ |
| Queues / request forms / workflows | ✅ | ✅ | ✅ | — | — | ✅ |
| On-call schedules + paging | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Escalation policies (multi-step)** | ✅ | ✅ | ✅ | ✅ | — | ⚠️ one-step only |
| **Major incident mgmt + postmortems/PIR** | ✅ | ✅ | ⚠️ | ✅ | — | ❌ |
| **Status page (service health)** | via add-on | ✅ (Statuspage) | ✅ | ✅ | — | ❌ |
| **Outbound webhooks / events API** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **API keys / programmatic tenant access** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (session tokens only) |
| Continuous posture + framework mapping | ✅ (GRC) | ⚠️ | ⚠️ | — | ✅ | ✅ (differentiator) |
| Evidence collection / assessor export | ✅ | — | — | — | ✅ | ⚠️ partial |
| SSO/SAML/OIDC + SCIM provisioning | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ IdP table, no live SSO/SCIM |
| Reporting + scheduled report export | ✅ (PA) | ✅ | ✅ | ✅ | ✅ | ⚠️ dashboards only |
| Gov cloud (IL4/5, FedRAMP/CMMC) | ⚠️ (GCC) | ❌ | ❌ | ❌ | ⚠️ | ✅ (differentiator) |

## Gaps, prioritized for enterprise readiness

**Tier 1 — close now (high value, on-brand, achievable):**
1. **Escalation policies** — configurable multi-step escalation (notify target → wait N min → next step → auto-create ticket), referenced by on-call schedules and alert rules. Closes the clearest PagerDuty/Opsgenie/ServiceNow gap; cleanly extends the alerts/on-call we own. **← first build increment.**
2. **Major Incident & Postmortem (PIR)** — declare a major incident (from a ticket or alert), severity/comms/timeline, and a structured post-incident review record. On-brand for a "cyber operations control plane."
3. **Status page** — internal service-health view (per-service status derived from open incidents/alerts), with incident history. Reuses services + incidents + alerts.

**Tier 2 — enterprise integration & access:**
4. **Outbound webhooks** — per-org webhook subscriptions dispatched from the existing event bus (ticket.*, alert.*, posture.*), with delivery log + retry. Enterprises integrate everything.
5. **API keys** — scoped, revocable programmatic tokens per org (distinct from user sessions) so customers can script against the API.
6. **Scheduled reports / export** — saved report definitions emailed/exported on a cadence (reuses analytics + notifications).

**Tier 3 — identity & compliance depth:**
7. **Live SSO (OIDC/SAML) + SCIM** provisioning against the existing `identity_providers` table (replaces dev-login in non-prod; prod already disables dev-login).
8. **Assessor evidence packaging** — one-click export of audit + posture + change + consent evidence as a FedRAMP/CMMC package (extends posture/compliance/audit).
9. **Vendor/third-party risk register** — track subprocessors/vendors and their posture (Vanta/Drata parity).

**Tier 4 — platform hardening (cross-cutting):**
10. Rate limiting + per-tenant quotas; secret rotation; per-tenant data export/erase (privacy); accessibility (WCAG) pass on the web; performance/load budget.

## Build sequencing

Each Tier-1/2 item is an independent feature (migration + module + API + client + page + nav + tests), following the established repo patterns. Build order: **Escalation policies → Major incident/PIR → Status page → Webhooks → API keys → Scheduled reports**, then Tier 3/4. Each ships behind its permissions and RLS, same as existing modules.

## This increment

This roadmap is the "enterprise plan." The **first increment built and deployed now is Escalation Policies** (Tier-1 #1) — see `docs/superpowers/plans/2026-06-12-escalation-policies.md`. Remaining tiers are queued as their own spec→plan→build cycles.

# Anchor — Taking It to the Next Level

**Date:** 2026-06-25
**Context:** After ServiceNow-parity Phases 1–4, KB build-out, and the experience layer, Anchor is a credible ITSM platform with a real differentiator (built-in ConMon/compliance evidence). This is a prioritized view of where the next leverage is — grounded in what already exists in the codebase.

---

## The strategic wedge
Anchor's unfair advantage over ServiceNow/Jira in this market is **ITSM that lives inside the FedRAMP boundary with continuous-monitoring evidence baked in** (conmon → posture findings → remediation tickets, tamper-evident audit hash-chain). Every "next level" bet below should reinforce that wedge: *the service desk that is also your compliance evidence engine, with no third-party SaaS in the boundary.*

---

## Tier 1 — Highest leverage (do next)

### 1. Intelligence layer (capability-gated)
The virtual agent is retrieval-only today because the gov enclave disables AI egress. The moment an approved in-boundary model is available (Azure OpenAI Gov / a hosted model), gate these on the existing `capability_matrix.ai`:
- **Agent assist:** suggested KB articles, draft replies, and auto-summary of long ticket threads.
- **Auto-triage:** suggested category/priority/assignment-group on ticket creation (the impact×urgency matrix already gives a baseline to blend with).
- **Answer synthesis** in Ask Anchor on top of the retrieval it already does.
*Why:* biggest perceived gap vs modern ServiceNow; the plumbing (KB search, catalog, deflection data) already exists.

### 2. Deflection & SLA analytics (data already captured)
- I just started writing `kb_deflections` (article "did this resolve your issue?"). Surface a **deflection-rate dashboard** (resolve % per article, tickets avoided) in Analytics — it proves the KB/virtual-agent ROI.
- Add **SLA-breach-risk** signals and backlog forecasting to the existing SLA engine + report builder.

### 3. Major Incident Management + Status Page
- A **"declare major incident"** flow (stakeholder comms, timeline, roles) layered on incidents + on-call (both already exist).
- A **customer-facing status page** driven by the new **Known Issues** space + announcements. High trust value for a gov service desk.

---

## Tier 2 — Strong differentiators

### 4. Microsoft Teams app
Notifications already flow to Teams. Close the loop with a **Teams app**: create/approve/triage tickets and approvals from Teams. Meets gov users where they work.

### 5. CMDB that populates itself
CIs + relationships now exist but are hand-entered. Add **Entra/Intune sync** to auto-create device/user/service CIs and relationships — turns the CMDB from a form into a live inventory and feeds compliance evidence.

### 6. Visual flow designer (canvas)
Phase 3 shipped a structured multi-step builder. The next step is a **drag-drop canvas** with branching/parallel paths and scheduled (time-based) triggers (auto-close stale, reminders, escalations).

---

## Tier 3 — Platform & reach

- **MSP white-label / per-tenant config:** customer-scoped branding, catalogs, and SLA policies so one Anchor serves many customers distinctly (the org model + RLS already support multi-tenancy).
- **Migration tooling:** importers from ServiceNow/Jira (tickets, KB, catalog) to lower switching cost — a direct sales accelerant.
- **Mobile/PWA + 508/WCAG certification:** an installable end-user experience and a formal accessibility pass (gov requirement).
- **HA/DR posture:** documented multi-region failover + restore runbooks (and surface it on the status page).

---

## Quick wins (days, not weeks)
- **Deflection dashboard** from `kb_deflections` (data is already flowing).
- **KB search tuning:** trigram/prefix matching so "wifi" matches "Wi-Fi" and URL-host tokens don't drop hits (today's known limitation).
- **Problem → Change linkage** to finish the change/problem workflow.
- **Report → dashboard:** save a report-builder definition as a pinned widget.
- **Known Issues → portal banner** auto-surface during an active major incident.

---

## Suggested sequencing
1. **Quick wins** + **deflection/SLA analytics** (proves value of what just shipped).
2. **Major incident + status page** (trust, visible to customers).
3. **Intelligence layer** when an in-boundary AI capability lands (largest differentiator).
4. **Teams app** and **CMDB auto-sync** (ecosystem depth).
5. **MSP white-label + migration tooling** (go-to-market scale).

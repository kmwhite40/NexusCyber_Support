# 04 — SLA, Escalation & On-Call (Section H)

---

## Section H: SLA, Escalation, and On-Call

This is one integrated subsystem: **one severity model** drives SLA timers, escalation policies, and on-call paging (principle P9). It serves all ticket types and the posture remediation flow.

### H.1 SLA policy model

SLA policies are resolved by precedence, most specific wins:

```
contract-specific  >  customer+service  >  customer  >  service  >  severity-default  >  global default
```

| Entity | Purpose | Key fields |
|--------|---------|-----------|
| `sla_policy` | A named policy | `id`, `org_id?`, `contract_id?`, `service_id?`, `applies_to` (type/severity filter), `priority`, `calendar_id`, `active` |
| `sla_target` | A target within a policy | `policy_id`, `metric` (`response`/`resolution`/`update`/`remediation`), `severity`/`priority`, `duration`, `pause_states[]`, `warn_at_pct` |
| `sla_instance` | A running timer on a ticket | `ticket_id`, `target_id`, `metric`, `started_at`, `due_at`, `paused_total`, `state` (running/paused/met/breached), `breached_at` |
| `business_calendar` | Hours/holidays | `id`, `org_id?`, `tz`, `weekly_hours`, `holidays[]`, `maintenance_windows[]`, `coverage` (8x5/24x7) |

**Metrics:** `response` (time to first agent response/ack), `resolution` (time to resolved), `update` (max gap between customer-visible updates), `remediation` (posture finding fix window by risk).

### H.2 Business hours, calendars, windows

- **Business hours**: per `business_calendar` (timezone-aware), e.g., 8×5 in customer's TZ, or **24×7** for premium contracts.
- **Holiday calendars**: per org/region; excluded from elapsed business time.
- **Maintenance windows**: scheduled windows can pause resolution timers (policy-configurable) and suppress certain alerts.

### H.3 SLA pause/resume

- **Pause conditions**: ticket enters a configured `pause_state` (e.g., `waiting_customer`, `waiting_vendor`, `on_hold`) — resolution timer pauses, response timer typically does not.
- **Resume conditions**: ticket leaves the pause state; elapsed paused time accumulates in `paused_total` and excludes from breach calc.
- **Update SLA** keeps running during waits to ensure the customer is kept informed even while paused (configurable).

### H.4 SLA calculation pseudocode

```text
function business_elapsed(start, now, calendar):
    # sum of working seconds between start and now per calendar/timezone,
    # excluding non-working hours, holidays, and (optionally) maintenance windows
    elapsed = 0
    cursor = start
    while cursor < now:
        if calendar.is_working(cursor) and not calendar.in_holiday(cursor):
            seg_end = min(now, calendar.next_boundary(cursor))
            elapsed += seconds(cursor, seg_end)
            cursor = seg_end
        else:
            cursor = calendar.next_working_start(cursor)
    return elapsed

function sla_state(instance, ticket, calendar):
    paused = instance.paused_total + current_pause_duration(ticket)
    consumed = business_elapsed(instance.started_at, now(), calendar) - paused
    remaining = instance.target_duration - consumed
    if instance.state == "met" or instance.state == "breached":
        return instance.state
    if remaining <= 0:
        return "breached"      # emit sla.breached once (idempotent)
    if consumed >= instance.target_duration * instance.warn_at_pct:
        return "warning"       # emit sla.warning once
    return "running"

# Timer evaluation runs on:
#  - every ticket event (status/assignment/comment), AND
#  - a periodic sweep (e.g., every 60s) for time-based warnings/breaches,
#    using idempotency keys so sla.warning / sla.breached fire exactly once.
```

> **Correctness controls** (mitigating "SLA timer inaccuracies" risk, see [12](./12-risk-adr-diagrams.md)): timezone/DST handled via IANA tz; warning/breach events carry idempotency keys; a reconciliation job recomputes open instances nightly; all pause/resume transitions are recorded in `ticket_events` for auditable replay.

### H.5 Breach handling

| Stage | Action |
|-------|--------|
| `warn_at_pct` (e.g., 75%) | `sla.warning` → notify assignee + group lead; surface in console |
| Approaching (e.g., 90%) | Escalation policy step may pre-empt (reassign/page) |
| Breach | `sla.breached` → escalate per policy, notify manager (+ customer per contract), flag in reporting, optional auto-page |

### H.6 Escalation policies

| Entity | Purpose | Fields |
|--------|---------|--------|
| `escalation_policy` | Ordered escalation for a scope | `id`, `org_id?`, `applies_to` (type/severity), `steps[]` |
| `escalation_step` | One rung | `policy_id`, `order`, `trigger` (no_ack / sla_warning / sla_breach / manual / time_in_state), `delay`, `targets` (group/role/user/oncall), `channels[]`, `repeat`, `stop_on_ack` |

Escalation dimensions: **assignment-group → tier → manager → customer → executive**. Each rung notifies via configured channels with retries; on no-acknowledgement within the rung's deadline, advance to the next rung.

### H.7 On-call model

| Entity | Purpose | Fields |
|--------|---------|--------|
| `oncall_schedule` | A rotation calendar for a team | `id`, `team`, `org_scope` (nexus/customer-set), `tz`, `coverage` (24x7/follow-the-sun), `layers[]` |
| `oncall_rotation` | A layer/rotation rule | `schedule_id`, `role` (primary/secondary/tertiary/backup/IC), `participants[]`, `length` (e.g., weekly), `handoff_time`, `restrictions` (business/after-hours) |
| `oncall_participant` | Person in rotation | `rotation_id`, `user_id`, `order`, `contact_methods[]` (push/sms/voice/teams/email), `quiet_hours` |
| `oncall_override` | PTO / swap / manual | `schedule_id`, `user_id`, `start`, `end`, `replaces_user_id`, `reason` |
| `oncall_acknowledgement` | Ack of a page | `page_id`, `user_id`, `acked_at`, `via` |

**Responder tiers:** Primary → Secondary → Tertiary → Backup → Incident Commander. **Rotation fairness:** balance shifts/after-hours load across participants; report on-call burden ([Section O](./07-automation-kb-reporting.md)). **PTO handling:** overrides auto-applied; conflicts flagged. **Shift swaps:** participant-initiated, approved, audited. **Manual overrides:** managers can override live with reason.

### H.8 Paging, acknowledgement & fatigue controls

| Control | Design |
|---------|--------|
| **Ack deadline** | Per severity (e.g., Sev1 = 5 min); no-ack → escalate to next responder/rung |
| **Notification retries** | Escalating channels (push → SMS → voice) with backoff until ack or exhaustion |
| **Notification channels** | Push, SMS, voice, Teams, email — availability per cloud ([06](./06-notifications-m365.md)); gov SMS/voice **🔍 requires validation / alternate provider** |
| **Fatigue controls** | De-dupe related alerts into one page; suppression windows; auto-resolve flapping; cap pages per responder per hour |
| **Quiet hours** | Per participant; low-severity respects quiet hours, Sev1 overrides |
| **Severity overrides** | Sev1/major incident bypasses quiet hours and goes straight to highest-urgency channels |

### H.9 On-call escalation sequence

```mermaid
sequenceDiagram
  participant SLA as SLA/Alert Engine
  participant ESC as Escalation Engine
  participant N as Notification Bus
  participant P1 as Primary On-Call
  participant P2 as Secondary On-Call
  participant MGR as Manager / IC
  SLA->>ESC: oncall.page_created (Sev1, ticket X)
  ESC->>N: Notify Primary (push+SMS) — ack deadline 5m
  N->>P1: Page
  alt Acked in time
    P1->>ESC: oncall.acknowledged
    ESC->>N: Stop escalation; assign ticket to P1
  else No ack within 5m
    ESC->>N: Escalate to Secondary (push+SMS+voice)
    N->>P2: Page
    alt Secondary acks
      P2->>ESC: oncall.acknowledged
    else Still no ack
      ESC->>N: Escalate to Manager / declare Major Incident path
      N->>MGR: Page + open bridge
    end
  end
  ESC->>SLA: Record ack latency (MTTA) + audit
```

### H.10 Major incident & post-incident review

```mermaid
flowchart TD
  A[Sev1/Sev2 incident or trigger] --> B{Declare Major Incident}
  B -->|mim.declare| C[Assign Incident Commander]
  C --> D[Open bridge: Teams/conference + comms channel]
  C --> E[Page on-call (IC + responders)]
  D --> F[Stakeholder comms cadence (customer + exec per policy)]
  E --> G[Coordinate diagnosis + runbook execution]
  G --> H{Resolved?}
  H -->|no| F
  H -->|yes| I[Resolve incident + customer comms]
  I --> J[Auto-create Post-Incident Review record]
  J --> K[Timeline assembled from ticket_events + page acks]
  K --> L[Root cause → Problem record; action items → tickets/changes]
  L --> M[PIR published; evidence retained]
```

- **Bridge workflow:** IC opens a bridge (Teams meeting/conference — gov availability 🔍), establishes comms cadence, assigns scribe (or AI-assisted timeline, [08](./08-ai-security-compliance.md), with human approval for customer-visible text).
- **Comms:** customer + executive updates on a fixed cadence via [Notification](./06-notifications-m365.md) broadcast, per contract.
- **Post-incident review (PIR):** auto-seeded from the audited event timeline; produces root cause → `problem` record and action items → tickets/changes; retained as evidence.
- **Runbook execution:** linked runbooks ([Section N](./07-automation-kb-reporting.md)) executed and logged; steps auditable.

### H.11 Posture remediation SLA linkage

A `posture_finding` ([05](./05-posture-cmdb.md)) carries a **remediation SLA** by risk rating (e.g., Critical = 7 days, High = 30, Moderate = 90). When a finding becomes a ticket, the `remediation` SLA target applies, can warn/breach, and can escalate to the customer's Security Contact and Nexus Security Analyst — closing the loop between posture, ticketing, SLA, and on-call.

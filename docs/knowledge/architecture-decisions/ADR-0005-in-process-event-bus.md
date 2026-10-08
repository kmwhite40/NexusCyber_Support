# ADR-0005 — In-process event bus in place of Azure Service Bus (for now)

| | |
|---|---|
| **Status** | Accepted — **deviates from spec ADR-005** |
| **Date** | 2026-06-11 |
| **Related** | Spec ADR-005, ADR-006; `apps/api/src/events/bus.ts` |

## Context
The spec chose Azure Service Bus + Event Grid with a transactional outbox. Anchor currently runs as a single API instance on a B1 App Service plan.

## Decision
Use an **in-process publish/subscribe bus** with the same event envelope the spec defines (`event_id`, `type`, `organization_id`, `idempotency_key`, `version`, `data`). Notifications, SLA, CAB and webhooks subscribe to it. The interface is kept narrow so a broker implementation can replace it without touching publishers.

## Alternatives considered
| Option | Why not (now) |
|---|---|
| Azure Service Bus + outbox | Extra gov resources, cost and ops for a single instance with modest volume. |
| Direct calls | Couples domains; loses the event catalog. |

## Consequences
**Positive:** zero infrastructure, simple to test.
**Negative:** events are **lost on process crash** and there is no DLQ; idempotency dedupe is in memory. Durable side effects therefore must be driven by database state plus sweepers (SLA sweeper, CAB deadline sweeper, Cloud PC poller), not by events alone.
**Revisit when:** running more than one API instance, or when an event loss becomes unacceptable.

# ADR-0010 — Pure planner + resumable executor for tenant changes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09 |
| **Related** | ES-06; `modules/provisioning/`, `modules/offboarding/` |

## Context
Onboarding (create user → set manager → licences → groups → credential → Windows 365 Cloud PC) and offboarding (block sign-in → revoke sessions → rename → convert to shared mailbox → remove licences → remove groups/roles) are multi-step Graph operations that can fail midway, and some steps are destructive and order-sensitive.

## Decision
1. A **pure planner** derives an ordered step list from the ticket's form data and current tenant state.
2. Operators see a **dry-run preview** first.
3. **Execute** is bound to the preview by a plan **fingerprint**; if anything changed the API returns *precondition failed* and the operator must re-preview.
4. A **resumable executor** records each step's result; a retry resumes at the failed step.
5. Long-running steps (Cloud PC) move the run to an `awaiting_*` state, completed by a background poller with a deadline.

## Consequences
**Positive:** planners are exhaustively unit-tested without a tenant; partial failures are recoverable; operators see exactly what will happen.
**Negative:** more states to model (awaiting, failed-at-step, resumable).
**Lesson recorded:** real runs found gaps no unit test could (dropped user attributes, missing manager step, free-text groups). The first run of any new step is supervised.

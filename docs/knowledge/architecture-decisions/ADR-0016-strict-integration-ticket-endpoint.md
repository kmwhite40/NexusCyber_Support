# ADR-0016 — A separate, strictly-parsed integration endpoint for external ticket sync

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-10-12 |
| **Deciders** | Anchor engineering |
| **Related** | ADR-0013 (external integration contract); `docs/nexus/anchor-integration-external-contract.md`; `docs/nexus/carbon-conmon-integration-response.md`; migration 0051; `http/routes.ts`, `modules/tickets.ts` |

## Context
ADR-0013 established the external integration contract on the existing `POST /api/v1/tickets`
route. The first real consumer (Carbon, for Application ConMon) has now specified its own
payload, and the mismatch is not a missing capability — it is field naming and parse
behaviour:

- Carbon sends `title`, `labels`, `metadata`; Anchor's fields are `subject`, `tags`,
  `customFields`. The required `subject` is absent from Carbon's shape, so the first call
  fails with `400`.
- Carbon sends `priority`, `dueDate`, `owner`, `controlIds`, `sourceId`, `carbonUrl`,
  `tenantId` and eight backlog-specific fields. **None of them exist on the route, and the
  zod schema is non-strict, so every one is stripped silently and the call returns `201`.**
- The response is the raw ticket row, not the `{ ticketId, ticketKey, created }` shape the
  consumer expects.

The silent-strip behaviour is the real hazard. A caller can sync successfully for months
while due dates and owners go nowhere, and the gap surfaces only when an auditor asks why a
POA&M has no due date. `POST /api/v1/tickets` is simultaneously the agent UI, customer
portal, service-catalog and mail-ingest intake path, so it cannot be made strict without
breaking those callers, and it should not grow a second response shape.

## Decision
Add **`POST /api/v1/integration/tickets`**, an integration-only route alongside the existing
`/api/v1/integration/*` management endpoints, that:

1. Accepts the external contract's payload names directly (`title`, `labels`, `metadata`,
   `source`, `externalRef`, …) and maps them internally to `subject`, `tags`, `customFields`,
   `externalSource`.
2. **Parses strictly — an unrecognised field is a `422`, never a silent drop.**
3. Returns a stable integration response shape (`ticketId`, `ticketKey`, `externalRef`,
   `status`, `created`) rather than the internal ticket row, so the column layout stays free
   to change.
4. Gives first-class homes to `dueDate`, `owner`, `controlIds` and `carbonUrl` instead of
   burying them in `custom_fields`, and resolves `parentExternalRef` to `parent_ticket_id`
   server-side.
5. **Suppresses SLA clock start when `source` marks the item as non-operational** (e.g. a
   build-backlog story). `startTicketSla` currently runs on every create path with targets
   hardcoded per derived priority and no `sla_policies` lookup, so there is no configuration
   that stops the clock — only code.

`POST /api/v1/tickets` keeps its current permissive behaviour and its `externalRef` upsert, so
existing integrations are unaffected and ADR-0013 stands.

## Alternatives considered
| Option | Why not |
|---|---|
| Widen `POST /api/v1/tickets` with the integration fields and aliases | Couples human intake to one consumer's contract; every future payload change lands in the path that creates tickets for agents and customers. Cannot be made strict without breaking the portal, catalog and mail-ingest callers. |
| Make the consumer map to Anchor's existing names; change nothing | Works, and is the recommended interim step so the consumer is not blocked on an Anchor deploy. But it leaves `dueDate`, `owner`, `controlIds` and the backlog fields with nowhere to go, and leaves the silent-strip hazard in place for the next integration. |
| Version the route (`/api/v2/tickets`) | A version bump implies the old shape is deprecated. It is not — it is the human intake path and stays. |
| Accept the payload but return a warning list of ignored fields | Warnings in a `201` body are not read by machines. A `422` is. |

## Consequences
**Positive:** a field a caller sends is either stored or loudly refused, never quietly lost;
the internal ticket row stops being part of an external contract; human intake is insulated
from integration churn.

**Negative / trade-offs:** two create paths to keep behaviourally consistent (priority
derivation, sensitive-key refusal, ticket-number allocation and the `external_ref` upsert must
be shared code, not duplicated); new columns or a typed `integration_fields` payload for
`dueDate` / `owner` / `controlIds`; strict parsing means adding a field to the consumer's
payload now requires an Anchor release first, so the field list must be agreed before the
consumer ships.

**Follow-ups:** the SLA-suppression rule needs a test that asserts no `sla_instances` row is
written for a suppressed source — it is the kind of thing a later refactor silently undoes.
Reopen-from-closed (`closed → reopened`) and the §5 webhook conformance gaps are tracked
separately as the consumer's phase B.

## Security & compliance
No change to the tenant boundary: the route authenticates with the same per-organization API
key, and the PDP still rejects an `organizationId` outside the key's scope with `403`. The
`customFields` sensitive-key refusal (PII vault boundary, ADR-0011) applies unchanged and must
be enforced on the new path before either branch writes — a strict parse makes that refusal
more reliable, not less. Audit and the hash-chained log are unaffected.

# Strict Integration Ticket Endpoint — Design Spec

**Date:** 2026-10-13
**Status:** Approved (brainstorming)
**Related:** `ADR-0016`, `ADR-0013`, `ADR-0015`, `docs/nexus/anchor-integration-external-contract.md`, `docs/nexus/carbon-conmon-integration-response.md`, `apps/api/src/modules/tickets.ts`, `apps/api/src/http/routes-extra.ts`

## Goal

Give the external GRC integration (Carbon, for Application ConMon) an endpoint whose contract
is its own: `POST /api/v1/integration/tickets`. It accepts the consumer's payload field names
directly, **refuses an unrecognised field instead of silently dropping it**, gives
`dueDate` / `owner` / `controlIds` / `carbonUrl` / `sourceId` real columns rather than burying
them in `custom_fields`, and returns a stable integration-shaped response that does not leak
the internal ticket row.

This is Anchor's phase **A′** in `carbon-conmon-integration-response.md` §7. It unblocks the
consumer's Sprint 1 task S1.7.

**The problem being fixed is not a missing capability.** Posting the consumer's documented
payload at the existing `POST /api/v1/tickets` today fails with `400` (it has no `subject`),
and a name-corrected payload returns `201` while discarding `priority`, `dueDate`, `owner`,
`controlIds`, `sourceId`, `carbonUrl`, `tenantId` and eight backlog fields — because that
route's zod schema is non-strict and strips unknown keys without comment. A caller can sync
successfully for months while due dates and owners go nowhere.

## Decisions (from brainstorming)

| Axis | Decision |
|------|----------|
| Route | New `POST /api/v1/integration/tickets`; existing `POST /api/v1/tickets` unchanged |
| Create path | **One** `createTicket`, extended with a nested `integration?` input group — not a second create path, not a core/adapter refactor |
| Unapplied fields | Three tiers: applied · accepted-but-not-applied (reported in `ignored[]`) · refused (`422`) |
| Field storage | Five typed, generically-named columns — not a jsonb blob, not reuse of existing columns |
| Backlog fields | Out of scope (phase D). Refused with an explicit `422`, not accepted-and-ignored |
| SLA suppression | Mechanism built and tested now; **no source triggers it in this pass** |
| Owner | Stored as text only; the integration never sets `assigned_agent_id` (dual-plane email ambiguity + scope bypass) |

## What already exists

- `external_ref` + `external_source` columns and `ux_tickets_org_external_ref`
  (unique per `(organization_id, external_ref)` where not null) — migration `0051`.
- Idempotent upsert on `external_ref` inside `tickets.createTicket`: a repeat updates in place
  and returns `matched: true`, which the route turns into `200` rather than `201`.
- Per-organization M2M API keys (`ak_<keyId>_<secret>`), scrypt-hashed, scoped to exactly one
  organization with a bounded verb set — `auth/api-key.ts`, `modules/api-keys.ts`.
- PDP org-scope rejection: `authorize()` → `inOrgScope()` → `Errors.forbidden` = **403** for an
  `organizationId` outside the key's scope. Needs no new work.
- `Errors.validation` = **422** carrying `errors[]` of `{ field, message }` (ADR-0015) — exactly
  the shape strict-parse rejection needs.
- `rejectSensitiveCustomFields` — refuses (422) any `customFields` key an admin has flagged
  `sensitive` on any form, guarding the PII vault boundary (ADR-0011).
- `nextTicketNumber` under a transaction-scoped advisory lock.
- `Idempotency-Key` replay on mutating requests (`http/idempotency.ts`).
- Existing `/api/v1/integration/*` routes for api-keys and webhooks in `routes-extra.ts`.

## What is missing (this build)

### 1. Route and auth

`POST /api/v1/integration/tickets`, registered in `http/routes-extra.ts` beside the existing
`/api/v1/integration/api-keys` and `/api/v1/integration/webhooks`.

- **Auth:** the same per-organization M2M API key (`Authorization: Bearer ak_<keyId>_<secret>`).
  Requires the `ticket.create` verb, which is in `DEFAULT_KEY_SCOPES` — the upsert branch
  updates but still authorizes as `ticket.create`, so no new scope and no change to
  `ALLOWED_KEY_SCOPES` is needed.
- **Org scope:** inherited. `createTicket` calls `authorize(actor, 'ticket.create', { organizationId })`
  and the PDP rejects an out-of-scope organization with **403**. No new check to write.
- **Status codes:** `201` on create, `200` when an existing `externalRef` was matched and
  updated — the same convention the existing route uses, surfaced to the caller as `created`.
- **`Idempotency-Key`:** honoured automatically by the global `onRequest` hook. Note its store
  is an in-process `Map` with a 10-minute TTL, short of the consumer's requested ~24 hours; the
  `external_ref` unique index is the real idempotency backstop here, so this is recorded as a
  known limitation (ADR-0015) rather than fixed in this pass.

### 2. Migration — five columns

```sql
ALTER TABLE tickets
  ADD COLUMN external_due_at   timestamptz,
  ADD COLUMN external_owner    text,
  ADD COLUMN external_source_id text,
  ADD COLUMN control_ids       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN external_url      text;

CREATE INDEX ix_tickets_control_ids ON tickets USING gin(control_ids);
```

Names are deliberately vendor-neutral (`external_url`, not `carbon_url`) so a second
integration reuses them. `external_source_id` carries the consumer's own item id: it is the
stable handle to their item **independent of the `externalRef` string format**, which their
own documentation warns is duplicated on their side and may change.

`control_ids` is a queryable array, not a tag list, because "which tickets touch CA-7" is a
real GRC reporting question and `tags` is a user-facing labelling field with different
semantics.

Forward-only, per ADR-0003. Nothing in `seed.ts` needs a dual-write: these columns are
integration-populated and have no seeded rows.

### 3. `modules/integration-tickets.ts` — new

Does exactly three things and holds no business logic, so it can be tested in isolation and
read as the contract:

1. **Strict-parse** the payload (`z.object({...}).strict()`).
2. **Rename** the consumer's vocabulary to Anchor's (`title`→`subject`, `labels`→`tags`,
   `metadata`→`customFields`, `source`→`externalSource`) and map `severity` to
   `impact`/`urgency`.
3. **Serialize** the response and compute `ignored[]`.

It calls `tickets.createTicket` for all persistence.

#### Field tiers

| Tier | Fields | Behaviour |
|---|---|---|
| **Applied** | `externalRef` (required, 1–200), `organizationId` (required uuid), `source` (required, ≤60), `title`→`subject` (required, 3–300), `description`, `severity`, `sourceId`, `owner`, `controlIds`, `dueDate`, `labels`→`tags`, `carbonUrl`, `metadata` | persisted |
| **Accepted, not applied** | `status`, `priority`, `tenantId` | persisted nowhere; **each listed in the response's `ignored[]`** |
| **Refused — 422** | `parentExternalRef`, `estimateDays`, `phase`, `workstream`, `acceptanceCriteria`, `blockedReason` | `422` naming the field and citing phase D |
| **Refused — 422** | anything unrecognised | `422` naming each unknown key |

`externalRef` is **required** on this endpoint: it is upsert-only, and a caller with no
idempotency key should use `POST /api/v1/tickets`. It is **not** validated as a uuid or parsed
for structure — a programme-scoped key such as `carbon-conmon:backlog:WS-1.1` must work
unchanged, and parsing the consumer's ref format would couple Anchor to a format they warn can
change.

`tenantId` is accepted and ignored because **Anchor has no tenant concept** — organizations are
the only isolation boundary.

#### Why `status` and `priority` are reported rather than refused

The consumer's documented payload always carries both. Anchor owns the ticket lifecycle (status
moves only through `/transition`) and **derives** priority from impact × urgency, so neither can
be applied. A hard `422` would reject every conformant request forever; a silent drop is the
hazard ADR-0016 exists to eliminate. The third option is a machine-readable
`ignored: ["status","priority","tenantId"]` in the response: the caller's payload works
unchanged and their sync can log or alert on it. Unknown fields still `422`.

#### Severity drives priority here

`severity` is mapped server-side to `impact`/`urgency` using the published contract mapping, so
`priority` derives correctly without the caller computing it:

`critical→(1,1) P1 · high→(2,2) P2 · medium→(3,3) P3 · low→(4,4) P4 · null→(3,3) P3`

This is a deliberate behaviour difference from `POST /api/v1/tickets`, which stores `severity`
descriptively and ignores it for priority. Document it in the external contract.

#### Response

```jsonc
{
  "ticketId": "<uuid>",
  "ticketKey": "<ticket_number>",
  "externalRef": "...",
  "status": "triage",          // authoritative — Anchor's, not what the caller sent
  "assignee": "a@example.gov", // Anchor's current assignment, or null — never set from `owner`
  "dueDate": "...",            // external_due_at — the caller's deadline, NOT resolution_due_at
  "createdAt": "...",
  "updatedAt": "...",
  "created": true,             // mirrors 201 create / 200 matched-and-updated
  "ignored": ["status", "priority"]
}
```

`dueDate` echoes `external_due_at` deliberately. Returning Anchor's SLA `resolution_due_at`
under a field the consumer reads as "my POA&M deadline" would be actively misleading.

### 4. `tickets.ts` changes

**`CreateTicketInput` gains one nested group**, not five loose parameters, so existing call
sites stay readable and the human-intake zod schema simply never exposes it:

```ts
integration?: {
  dueAt?: string | null;
  owner?: string | null;
  controlIds?: string[];
  url?: string | null;
  sourceId?: string | null;
  suppressSla?: boolean;
};
```

**Extract `stampSlaAndTriage(sql, ticket)`** from `createTicket`. Today the post-insert step
starts the SLA and stamps `status='triage'` in one `UPDATE`. The helper honours
`integration.suppressSla`: when set it stamps `status='triage'` but writes **no `sla_instances`
rows and no due-date stamps**. This is the one targeted improvement to a function already doing
too much, and it is the line the new behaviour needs.

**Insert branch** persists the five new columns.

**Upsert (update) branch** refreshes the five new columns and must **not** touch `status`,
`assigned_agent_id` or `ticket_number`. The consumer's own contract says Anchor owns the
assignment after creation; a re-sync that reassigned a ticket an agent had picked up would be a
correctness bug visible to humans.

### 5. Owner

`external_owner` stores the string as given, and **the integration never sets
`assigned_agent_id`**. Assignment stays entirely Anchor's, which is what the consumer's own
contract says (§1: "Anchor owns the assignment").

Auto-resolving an email to an agent was considered and rejected. `users` is
`UNIQUE (plane, email)` over a `citext` email, so a single address can hold **both** a
customer-plane row and a nexus-plane row — the normal state for SBS staff, who get a customer
row from roster sync and a nexus row as agents — making "the user with this email" ambiguous by
construction. Nexus-plane agents are also not scoped by `users.organization_id` (they are scoped
via `assignedOrgs` on the principal), so an org-filtered match would miss the real agents and hit
customer rows instead. Resolving here would additionally bypass the scope check `assignTicket`
performs, letting a ticket land on an agent not scoped to that organization.

The consumer's `owner` is frequently a team name or a person with no Anchor account, so storing
it as text loses nothing. The response's `assignee` reports Anchor's actual assignment — `null`
until an agent picks the ticket up.

### 6. SLA suppression — mechanism, not policy

`suppressSla` is built and tested in this pass but **nothing sets it**: remediation tickets want
their clock. It exists so phase D can switch it on for `source: backlog` without reopening the
create path.

This matters because there is no configuration that stops the clock. `startTicketSla` writes
`sla_instances` rows on every create path, with targets hardcoded per derived priority
(`targetMinutes`), and `sla_policies` is **never read by any module**. Suppression can only be
code.

### 7. Error handling

All errors are existing RFC 7807 problem documents (ADR-0015); no new error machinery.

| Case | Status | Shape |
|---|---|---|
| unknown field(s) | 422 | `Errors.validation` with one `errors[]` entry per unknown key |
| backlog field | 422 | `errors[]` entry naming the field, detail citing phase D |
| missing `title` / `externalRef` / `organizationId` | 422 | `errors[]` per field |
| `organizationId` outside key scope | 403 | existing PDP `Errors.forbidden` |
| sensitive key in `metadata` | 422 | existing `rejectSensitiveCustomFields` |

## Testing

New `apps/api/test/integration/integration-tickets.int.test.ts`:

1. create → `201`, `created: true`, all five columns persisted
2. re-POST same `externalRef` → `200`, `created: false`, same `ticketId` and `ticketKey`, fields updated
3. **non-clobber:** after an Anchor transition and reassignment, a re-sync leaves `status` and `assigned_agent_id` untouched
4. unknown field → `422` naming that field in `errors[]`
5. backlog field → `422` citing phase D
6. `organizationId` outside the key's scope → `403`
7. sensitive key in `metadata` → `422`
8. `metadata` round-trips semantically (not byte-identically — it is `jsonb`)
9. `owner` is stored in `external_owner` and **does not** set `assigned_agent_id`; `assignee` stays `null` on a fresh ticket even when `owner` matches an existing agent's email
10. `severity: "high"` → `priority: "P2"`
11. `ignored[]` contains exactly `status`, `priority`, `tenantId` when those are sent
12. `externalRef` with a non-uuid first segment is accepted

Plus a unit test: `suppressSla: true` writes **zero** `sla_instances` rows. ADR-0016 flags this
as the assertion a later refactor silently undoes.

⚠ **These tests need the root `.env` loaded or they connect to the wrong Postgres, skip
silently, and the suite still reports green.** The implementation plan must pin the exact
command rather than leaving it to `npm test`.

## Documentation to update on merge

- `docs/nexus/anchor-integration-external-contract.md` — add the new endpoint, the three field
  tiers, the `ignored[]` array, and the server-side severity→priority mapping.
- `docs/nexus/carbon-conmon-integration-response.md` — mark A′ shipped in §7.
- `ADR-0016` — Proposed → Accepted.

## Out of scope

Phase D backlog fields and the `blocked` status; `PATCH /tickets/:id`; reopen-from-closed
(`closed → reopened`); the §5 webhook conformance work (timestamp header, delivery-id rename,
durable retry, `resolution`, `ticket.updated`); the delta feed and batch lookup; per-key rate
limits. Each is tracked in `carbon-conmon-integration-response.md` §7.

**Also explicitly out of scope:** which Anchor organization owns the consumer's 72 backlog
items. That question is open with the consumer (`carbon-conmon-integration-response.md` §6) and
gates phase D, not this work.

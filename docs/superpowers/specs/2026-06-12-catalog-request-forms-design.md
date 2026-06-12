# Catalog Request Forms — Design Spec

**Date:** 2026-06-12
**Status:** Approved (brainstorming)
**Related:** `apps/api/src/db/migrations/0021_request_forms.sql`, `apps/api/src/modules/forms.ts`, `apps/api/src/modules/catalog.ts`, `apps/web/app/(app)/catalog/page.tsx`

## Goal

Integrate JSM-style custom request forms into the service catalog. When a catalog item has a
form, requesting it shows a dynamic, typed form (people pickers, system select, attachment)
instead of the generic subject/description modal. First form: **New user creation &
provisioning** (`user.provisioning`).

The pasted target form's fields:
- Raise this request on behalf of* (people picker → ticket requester)
- Summary* (text → ticket subject; placeholder "e.g. Create an account on Jira")
- Select a system* (select)
- Tell us why you need an account (textarea → ticket description)
- Manager (people picker)
- Approvers (multi people picker → approval steps)
- Attachment (file upload)
- Send

## Decisions (from brainstorming)

| Axis | Decision |
|------|----------|
| Renderer | Generic dynamic-form renderer (any catalog item can have a form), not a one-off |
| People fields | Searchable user pickers (store user id), scoped by org |
| Submit wiring | On-behalf-of sets requester; attachment upload; approvers → real approval steps |

## What already exists

- `request_forms` (global or org-scoped, keyed) + `form_fields` (typed: text/textarea/number/
  select/checkbox/date, required, options, position). RLS in place.
- `forms.ts`: `validateAgainstForm` (pure), `getForm`, `listForms`, `createForm`, `addField`,
  `submitAnswers` (merges into `tickets.custom_fields`).
- `catalog.createRequest`: builds ticket + SLA + fulfillment tasks; when `requires_approval`,
  inserts an `approvals` row (status `requested`) and publishes `approval.requested`.
- Attachments API: `POST /api/v1/tickets/:id/attachments` (+ list/download), validated/scanned.
- `approval_steps(approval_id, step_order, approver_id, decision, reason, decided_at)`.
- `GET /api/v1/organizations/:id/users` (org user list).

## What is missing (this build)

1. HTTP routes to fetch a form and to search users.
2. A catalog item → form link.
3. Field types for people pickers and attachment, plus answer→ticket routing.
4. Web rendering of the dynamic form.

## Architecture

### 1. Schema — migration `00NN_catalog_request_forms.sql` (next free number at build time)

- `ALTER TABLE service_catalog_items ADD COLUMN form_key text;` — links to a `request_forms.key`
  (global form). NULL → generic modal.
- Extend `form_fields.data_type` CHECK to add `user`, `user_multi`, `attachment`.
- `ALTER TABLE form_fields ADD COLUMN maps_to text;` — semantic routing of the answer:
  `subject | description | requester | manager | approvers | attachment | NULL (=custom_fields)`.
- Seed the `new_user_provisioning` global form (`organization_id NULL`, `ticket_type
  access_request`) and its fields:

  | key | label | data_type | required | maps_to | options |
  |-----|-------|-----------|----------|---------|---------|
  | on_behalf_of | Raise this request on behalf of | user | true | requester | — |
  | summary | Summary | text | true | subject | — |
  | system | Select a system | select | true | (custom) | M365 / Entra ID, Azure Government, AWS GovCloud, Jira, ServiceNow, VPN |
  | reason | Tell us why you need an account | textarea | false | description | — |
  | manager | Manager | user | false | manager | — |
  | approvers | Approvers | user_multi | false | approvers | — |
  | attachment | Attachment | attachment | false | attachment | — |

- `UPDATE service_catalog_items SET form_key='new_user_provisioning' WHERE key='user.provisioning';`

The migration is idempotent (`ADD COLUMN IF NOT EXISTS`, seed guarded by `ON CONFLICT`/existence).

### 2. Backend

**`forms.ts` changes**
- Extend `FieldType` union + `validateAgainstForm`:
  - `user`: value must be a non-empty string (user id). (Existence is enforced at submit via a
    DB lookup, not in the pure validator.)
  - `user_multi`: value must be an array of strings (may be empty unless required).
  - `attachment`: not validated here (file handled out-of-band); skip in the pure validator.
- `getFormByCatalogKey(actor, catalogKey)`: resolve `service_catalog_items.form_key` → load the
  form + fields. Returns `null` when the item has no form.

**`catalog.ts` `createRequest` extension**
- New input: `answers?: Record<string, unknown>` (keyed by field key).
- When the item has a `form_key`:
  1. Load form fields; `validateAgainstForm(fields, answers)` → 422 on failure.
  2. Resolve mapped fields by `maps_to`:
     - `subject` ← `summary` (fallback to item.name)
     - `description` ← `reason`
     - `requester` ← `on_behalf_of` (a user id) → set `requester_id` AND `affected_user_id`.
       For a customer actor, default to `actor.id` if unset. For a nexus actor, required.
     - `manager`, `system`, and any unmapped fields → `custom_fields`.
     - `approvers` ← `user_multi` of user ids.
     - `attachment` → ignored server-side at create (uploaded separately by the web).
  3. Create the ticket as today, but with `requester_id`/`affected_user_id` from on-behalf-of
     and `custom_fields` set, and `custom_fields._form = form key`.
  4. When `requires_approval`: after inserting the `approvals` row, insert one `approval_steps`
     row per approver id (`step_order` ascending). If no approvers chosen, the approval exists
     with no steps (current behavior — a manager/admin decides via the existing approve route).
- Validate approver/requester ids belong to the request's org (RLS already scopes; an explicit
  existence check returns a clean 422 rather than a FK error).

**Routes (`routes.ts`)**
- `GET /api/v1/catalog/:key/form` → `forms.getFormByCatalogKey`; 404 → `{ form: null }` (web shows
  generic modal). `ticket.create` authz.
- `GET /api/v1/users/search?q=&organizationId=` → search `users` by name/email (ILIKE), limited
  (e.g. 10), RLS-scoped: customer → own org; nexus → the supplied `organizationId` (must be in
  scope) or any assigned org. Returns `{ id, display_name, email }`. `ticket.create` authz.
- Extend `POST /api/v1/catalog/:key/request` body: `{ subject?, description?, organizationId?,
  answers? }`. Returns the created ticket (with `id`).

### 3. Web — `apps/web/app/(app)/catalog/page.tsx`

- On opening `RequestModal`, fetch `GET /catalog/:key/form`. If a form is returned, render the
  dynamic form; otherwise the current generic modal.
- Dynamic renderer maps `data_type` → input:
  - `text`/`textarea`/`select`/`number`/`checkbox`/`date` → existing primitives.
  - `user` → `UserPicker` (single); `user_multi` → `UserPicker` (multi).
  - `attachment` → file drop (stores File objects in component state).
- `UserPicker` (new `apps/web/components/user-picker.tsx`): debounced `GET /users/search?q=&
  organizationId=`, renders name + email, stores selected id(s). Org id comes from the modal's
  org context (agents pick the customer org first — the existing org `Select`; customers use
  their own org).
- Layout matches the paste: header "Required fields are marked with an asterisk*", fields in the
  defined order with `*` on required, **Send** button.
- Submit: `POST /catalog/:key/request` with `{ organizationId, answers }` → on success, if a file
  was chosen, `POST /tickets/:id/attachments`, then redirect to `/tickets/:id`.
- API client (`apps/web/lib/api.ts`): add `catalog.form(key)`, `users.search(q, orgId)`, extend
  `catalog.request` to send `answers`, and an `attachments.upload(ticketId, file)` helper.

### 4. Validation & errors

- Server: required-field and type validation via `validateAgainstForm`; approver/requester
  existence check; 422 with concatenated per-field messages (matches existing error style).
- Web: surface the 422 detail; mark required fields; disable Send while submitting.

### 5. Testing

- `forms.test.ts`: `validateAgainstForm` for `user` (string), `user_multi` (array), `attachment`
  (skipped), plus required handling.
- `catalog` submit routing: a unit test (fake `Sql`) asserting `summary→subject`,
  `reason→description`, `on_behalf_of→requester_id`, unmapped→`custom_fields`, and one
  `approval_steps` insert per approver.
- `users/search`: scoping test (customer limited to own org).
- Web: manual verification against the running app (no web test harness).

## Tiers (for the implementation plan)

1. **Schema + read endpoints** — migration + seed, `getFormByCatalogKey`, `GET /catalog/:key/form`,
   `GET /users/search`. Shippable: the form is fetchable and users are searchable.
2. **Submit routing** — extend `createRequest` (mapped fields + approval steps) + extended
   validation. Shippable: a form request creates the right ticket via API.
3. **Web** — dynamic renderer + `UserPicker` + attachment + layout. Shippable: the form works in
   the catalog UI end to end.

## Out of scope (YAGNI / future)

- A form **builder** UI (forms are seeded/managed via existing `forms.ts` admin functions).
- Conditional/branching fields, field validation rules beyond required/type, multi-page forms.
- Rich-text editor for "why" (a `textarea` is used; the paste's "Normal text" toolbar is not
  replicated).
- Per-approver ordering/parallel-vs-serial approval policy (steps are inserted in pick order;
  the existing approve route decides the approval as a whole).
- Forms for catalog items other than `user.provisioning` (the generic renderer supports them;
  defining more forms is follow-up data work).

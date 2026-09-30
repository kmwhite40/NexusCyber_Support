// The submitted catalog form, read back for the people fulfilling it.
//
// A catalog request scatters its answers on the way in (forms.ts mapFormAnswers): most land in
// tickets.custom_fields, but the subject/description/requester/affected columns, the approval
// steps and the sensitive-fields store each take a share. The ticket page only ever showed the
// description, so an admin working an onboarding request could not see what was asked for. This
// module puts the answers back together, in the form's own order and sections, with user UUIDs
// resolved to names.
//
// PII stays behind its gate: sensitive values are returned only when the caller holds `pii.view`
// AND explicitly asked for them, and then only via readSensitive — so every reveal still writes
// its `pii.viewed` audit entry. A plain page load never reveals, and never audits.
import { withSystemContext, type Sql } from '../db/pool.js';
import { can } from '../authz/pdp.js';
import { Errors } from '../errors.js';
import { getTicket } from './tickets.js';
import { readSensitive } from './sensitive-fields.js';
import { isFieldVisible, type FieldType } from './form-fields.js';
import type { Principal } from '../types.js';

export const OTHER_SECTION = 'Other answers';

export type PiiState = 'included' | 'withheld' | 'purged' | 'none';

export interface FieldDef {
  key: string;
  label: string;
  data_type: FieldType | string;
  options?: string[];
  maps_to: string | null;
  visible_when: any;
  sensitive: boolean;
  section: string | null;
  /** Needed by the edit path (validation) and the edit UI; optional so hand-built fixtures
   *  need not set them. */
  required?: boolean;
  options_source?: string | null;
}

export interface UserRef { id: string; name: string | null; email: string | null }

export interface SubmittedField {
  key: string;
  label: string;
  data_type: string;
  /** Raw stored answer, normalised: multi-value answers are always arrays. Null when unanswered,
   *  withheld, or purged. */
  value: unknown;
  /** Human-readable rendering: user UUIDs become "Name <email>", booleans Yes/No. Arrays stay
   *  arrays so the UI can render chips. Null when there is nothing to show. */
  display: string | string[] | null;
  sensitive: boolean;
}

export interface SubmittedSection { section: string | null; fields: SubmittedField[] }

/** A field definition as the edit UI needs it — the same shape the catalog form endpoint returns,
 *  plus whether (and why not) THIS ticket lets it be changed. */
export interface EditableFieldDef {
  key: string;
  label: string;
  data_type: string;
  required: boolean;
  options: string[];
  options_source: string | null;
  visible_when: any;
  sensitive: boolean;
  section: string | null;
  maps_to: string | null;
  /** Null when editable; otherwise the reason it is not. */
  locked: string | null;
}

/** Whether the answers can be edited right now, and which fields are pinned. */
export interface EditState {
  /** Null when edits are allowed; otherwise the reason the whole form is frozen. */
  blocked: string | null;
  /** key -> reason, for fields that cannot be changed on this ticket. */
  locked: Record<string, string>;
}

export interface SubmittedForm {
  form_key: string | null;
  form_name: string | null;
  sections: SubmittedSection[];
  /** Field definitions for the edit UI, in form order. */
  fields: EditableFieldDef[];
  edit: EditState;
  requester: UserRef | null;
  affected_user: UserRef | null;
  approvers: Array<{ name: string | null; email: string | null; status: string }>;
  notes: string | null;
  pii: PiiState;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MULTI_TYPES = new Set(['multiselect', 'user_multi']);
// security_groups was a free-text textarea before 0078 made it a multiselect; tickets filed
// before then hold a comma/newline-separated string. Normalise both shapes to an array.
const ALWAYS_MULTI_KEYS = new Set(['security_groups']);
const USER_TYPES = new Set(['user', 'user_multi']);
const TERMINAL = new Set(['resolved', 'closed']);

// ---------------------------------------------------------------- edit guards (pure)
// Kept here, beside the reader, so GET can tell the UI what is editable using exactly the rule the
// PATCH enforces (ticket-form-edit.ts imports these; nothing imports back).

/** Onboarding run statuses during which the answers are being acted on. Mirrors
 *  IN_FLIGHT_RUN_STATUSES in modules/provisioning/index.ts (not imported: that module is owned
 *  by another change and pulls in the Graph client). */
export const ONBOARDING_INFLIGHT = new Set(['running', 'awaiting_cloudpc']);
/** Offboarding run statuses during which the answers are armed or being acted on. Mirrors
 *  IN_FLIGHT_OFFBOARD_STATUSES in modules/offboarding/index.ts. */
export const OFFBOARDING_INFLIGHT = new Set(['scheduled', 'running']);
/** Offboarding statuses meaning the teardown has already touched the departing account. */
const OFFBOARDING_RAN = new Set(['needs_review', 'succeeded']);
/** Answers the onboarding planner derives the UPN and display name from (planner.ts deriveUpn). */
export const IDENTITY_KEYS = new Set(['legal_first_name', 'legal_last_name', 'preferred_first_name']);

export interface RunRow {
  kind: string;
  status: string;
  /** True when this run's create_user step succeeded — the account exists even if the run
   *  later failed. */
  account_created?: boolean;
}

export const APPROVERS_LOCKED =
  'Approvers cannot be changed after submission: approval decisions already recorded would silently change.';

/** Decide whether a ticket's answers may be edited, and which fields are pinned. Pure. */
export function editGuards(
  ticketStatus: string,
  runs: RunRow[],
  fields: Array<Pick<FieldDef, 'key' | 'maps_to' | 'data_type'>>,
): EditState {
  let blocked: string | null = null;
  if (TERMINAL.has(ticketStatus)) {
    blocked = `This request is ${ticketStatus}; its answers can no longer be edited.`;
  } else if (runs.some((r) => r.kind === 'onboarding' && ONBOARDING_INFLIGHT.has(r.status))) {
    blocked = 'Account provisioning is in progress for this request. Edit the answers after the run finishes.';
  } else if (runs.some((r) => r.kind === 'offboarding' && OFFBOARDING_INFLIGHT.has(r.status))) {
    blocked = runs.some((r) => r.kind === 'offboarding' && r.status === 'scheduled')
      ? 'An offboarding run is scheduled for this request. Cancel it before changing the answers.'
      : 'An offboarding run is in progress for this request. Edit the answers after it finishes.';
  }

  const locked: Record<string, string> = {};
  const accountExists = runs.some(
    (r) => r.kind === 'onboarding' && (r.status === 'succeeded' || r.account_created === true),
  );
  const offboardRan = runs.some((r) => r.kind === 'offboarding' && OFFBOARDING_RAN.has(r.status));
  for (const f of fields) {
    if (f.maps_to === 'approvers') locked[f.key] = APPROVERS_LOCKED;
    else if (f.data_type === 'attachment' || f.maps_to === 'attachment') locked[f.key] = 'Attachments are managed in the attachments panel.';
    else if (accountExists && IDENTITY_KEYS.has(f.key)) {
      locked[f.key] =
        'The account has already been created, and its sign-in name was derived from this name. Rename the user in Entra instead; changing it here would not rename the account.';
    } else if (offboardRan && f.maps_to === 'affected') {
      locked[f.key] = 'The offboarding has already run against this person, so who it is about can no longer be changed.';
    }
  }
  return { blocked, locked };
}

/**
 * Guard for the legacy POST /tickets/:id/form-answers. That route merged ANY form's answers into
 * any ticket for a mere ticket.update holder — enough for a Tier1 to re-point an armed
 * offboarding's departing_user. It now only ATTACHES a form to a ticket that has none, and only
 * the form the ticket's catalog item names (if any); correcting a submitted form goes through
 * PATCH /tickets/:id/form (ticket-form-edit.ts), with its permission, guards and audit trail. Pure.
 */
export function formAnswersRefusal(input: {
  ticketStatus: string;
  existingForm: string | null;
  formId: string;
  formKey: string | null;
  catalogFormKey: string | null;
  runs: Array<{ kind: string; status: string }>;
}): string | null {
  if (input.existingForm) {
    return 'this ticket already has a submitted request form; correct its answers with PATCH /tickets/:id/form';
  }
  if (input.catalogFormKey && input.catalogFormKey !== input.formKey) {
    return `this ticket's catalog item uses the ${input.catalogFormKey} form; a different form cannot be attached`;
  }
  const g = editGuards(input.ticketStatus, input.runs, []);
  return g.blocked;
}

/** Load the provisioning/offboarding runs that bear on editing a ticket's answers. */
export async function loadRunsForEdit(sql: Sql, ticketId: string): Promise<RunRow[]> {
  const { rows } = await sql.query(
    `SELECT r.kind, r.status,
            EXISTS (SELECT 1 FROM provisioning_steps s
                     WHERE s.run_id = r.id AND s.step_key = 'create_user' AND s.status = 'succeeded') AS account_created
       FROM provisioning_runs r WHERE r.ticket_id = $1`,
    [ticketId],
  );
  return rows as RunRow[];
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Split a legacy delimited string into an array; leave arrays as-is. Pure. */
export function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.filter((x) => !isEmpty(x));
  if (typeof v === 'string') return v.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
  if (isEmpty(v)) return [];
  return [v];
}

export function userLabel(u: UserRef | undefined, fallback: string): string {
  if (!u) return fallback;
  if (u.name && u.email) return `${u.name} <${u.email}>`;
  return u.name ?? u.email ?? fallback;
}

function humanize(key: string): string {
  const s = key.replace(/[_.]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function displayScalar(v: unknown, isUser: boolean, users: Map<string, UserRef>): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' && (isUser || UUID.test(v)) && users.has(v)) return userLabel(users.get(v), v);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

function render(v: unknown, dataType: string, key: string, users: Map<string, UserRef>): { value: unknown; display: string | string[] | null } {
  const isUser = USER_TYPES.has(dataType);
  if (MULTI_TYPES.has(dataType) || ALWAYS_MULTI_KEYS.has(key) || Array.isArray(v)) {
    const arr = toArray(v);
    return arr.length === 0
      ? { value: null, display: null }
      : { value: arr, display: arr.map((x) => displayScalar(x, isUser, users)) };
  }
  if (isEmpty(v)) return { value: null, display: null };
  return { value: v, display: displayScalar(v, isUser, users) };
}

export interface ShapeInput {
  formKey: string | null;
  formName: string | null;
  fields: FieldDef[];
  ticket: {
    status: string;
    description: string | null;
    requester_id: string | null;
    affected_user_id: string | null;
    custom_fields: Record<string, unknown> | null;
  };
  approvers: Array<{ approver_id: string | null; name: string | null; email: string | null; status: string }>;
  users: Map<string, UserRef>;
  /** Keys that currently have a row in ticket_sensitive_fields (keys only, never values). */
  sensitiveKeys: string[];
  /** Values, present only when the caller was allowed to and asked to see them. */
  sensitiveValues: Record<string, string> | null;
  /** Provisioning/offboarding runs for this ticket (drives `edit`). Absent = none. */
  runs?: RunRow[];
}

/** Decide the PII state. Pure. */
export function piiState(input: Pick<ShapeInput, 'fields' | 'ticket' | 'sensitiveKeys' | 'sensitiveValues'>): PiiState {
  if (input.sensitiveKeys.length > 0) return input.sensitiveValues ? 'included' : 'withheld';
  // Nothing stored. If the form captures PII and the ticket is terminal, the retention job has
  // (or will have) deleted it — say so, rather than implying none was ever collected.
  const formHasPii = input.fields.some((f) => f.sensitive);
  if (formHasPii && TERMINAL.has(input.ticket.status)) return 'purged';
  return 'none';
}

/** Assemble the submitted form from its scattered pieces. Pure — all I/O is done by the caller. */
export function shapeSubmittedForm(input: ShapeInput): SubmittedForm {
  const cf = { ...(input.ticket.custom_fields ?? {}) };
  const pii = piiState(input);
  const sensitiveStored = new Set(input.sensitiveKeys);
  const approverIds = input.approvers.map((a) => a.approver_id).filter((x): x is string => !!x);

  // Answers that mapFormAnswers routed onto columns rather than custom_fields, put back so each
  // field shows what was actually submitted. Visibility needs the full answer set.
  const answerFor = (f: FieldDef): unknown => {
    if (f.key in cf) return cf[f.key];
    switch (f.maps_to) {
      case 'description': return input.ticket.description;
      case 'requester': return input.ticket.requester_id;
      case 'affected': return input.ticket.affected_user_id;
      case 'approvers': return approverIds.length ? approverIds : undefined;
      default: return undefined;
    }
  };
  const answers: Record<string, unknown> = { ...cf };
  for (const f of input.fields) {
    const v = answerFor(f);
    if (v !== undefined) answers[f.key] = v;
  }

  const sections: SubmittedSection[] = [];
  const bySection = new Map<string | null, SubmittedSection>();
  const push = (section: string | null, field: SubmittedField) => {
    let s = bySection.get(section);
    if (!s) { s = { section, fields: [] }; bySection.set(section, s); sections.push(s); }
    s.fields.push(field);
  };

  const known = new Set<string>();
  for (const f of input.fields) {
    known.add(f.key);
    if (f.data_type === 'attachment' || f.maps_to === 'attachment') continue; // listed as attachments
    const base = { key: f.key, label: f.label, data_type: String(f.data_type), sensitive: !!f.sensitive };
    if (f.sensitive) {
      const stored = sensitiveStored.has(f.key);
      // Visibility conditions hang off non-sensitive answers (e.g. work_location), so a hidden
      // PII field was never asked — skip it, like any other hidden field.
      if (!stored && !isFieldVisible(f as any, answers)) continue;
      if (stored && input.sensitiveValues && f.key in input.sensitiveValues) {
        const r = render(input.sensitiveValues[f.key], String(f.data_type), f.key, input.users);
        push(f.section ?? null, { ...base, ...r });
      } else {
        push(f.section ?? null, { ...base, value: null, display: null });
      }
      continue;
    }
    const raw = answerFor(f);
    // Conditional fields that did not apply to this request (e.g. end_date on a permanent hire)
    // were never asked; showing them as blank would read as "left unanswered".
    if (isEmpty(raw) && !isFieldVisible(f as any, answers)) continue;
    push(f.section ?? null, { ...base, ...render(raw, String(f.data_type), f.key, input.users) });
  }

  // Forms evolve: keep answers whose field has since been renamed or removed.
  for (const [k, v] of Object.entries(cf)) {
    if (k.startsWith('_') || known.has(k) || isEmpty(v)) continue;
    const dt = Array.isArray(v) ? 'multiselect' : typeof v === 'boolean' ? 'checkbox' : 'text';
    push(OTHER_SECTION, { key: k, label: humanize(k), data_type: dt, sensitive: false, ...render(v, dt, k, input.users) });
  }

  const ref = (id: string | null): UserRef | null => (id ? input.users.get(id) ?? { id, name: null, email: null } : null);
  const hasNotesField = input.fields.some((f) => f.maps_to === 'description');
  const edit = editGuards(input.ticket.status, input.runs ?? [], input.fields);

  return {
    form_key: input.formKey,
    form_name: input.formName,
    sections,
    fields: input.fields.map((f) => ({
      key: f.key, label: f.label, data_type: String(f.data_type), required: !!f.required,
      options: f.options ?? [], options_source: f.options_source ?? null, visible_when: f.visible_when ?? null,
      sensitive: !!f.sensitive, section: f.section ?? null, maps_to: f.maps_to ?? null,
      locked: edit.locked[f.key] ?? null,
    })),
    edit,
    requester: ref(input.ticket.requester_id),
    affected_user: ref(input.ticket.affected_user_id),
    approvers: input.approvers.map((a) => ({ name: a.name, email: a.email, status: a.status })),
    notes: hasNotesField ? input.ticket.description ?? null : null,
    pii,
  };
}

/** Every UUID-looking value worth resolving to a user: user-typed fields, the ticket's people
 *  columns, and UUIDs among answers no longer on the form. Pure. */
export function userIdsToResolve(fields: FieldDef[], ticket: ShapeInput['ticket']): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => { for (const x of toArray(v)) if (typeof x === 'string' && UUID.test(x)) ids.add(x); };
  add(ticket.requester_id);
  add(ticket.affected_user_id);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(ticket.custom_fields ?? {})) {
    const f = byKey.get(k);
    if (!f || USER_TYPES.has(String(f.data_type))) add(v);
  }
  return [...ids];
}

/** Resolve the form a ticket was submitted with. `_form` wins; else the catalog item's form. An
 *  org's own form of that key wins over the global one. Shared with the edit path so a PATCH
 *  validates against exactly the definition GET displays. */
export async function loadFormDefs(sql: Sql, formRef: string | null, category: string | null, orgId: string) {
  let key = formRef;
  if (!key && category) {
    key = (await sql.query('SELECT form_key FROM service_catalog_items WHERE key=$1', [category])).rows[0]?.form_key ?? null;
  }
  if (!key) return null;
  // `_form` holds the form KEY on the catalog path and the form UUID on submitAnswers; accept
  // both. An org's own form of that key wins over the global one.
  const form = (
    await sql.query(
      `SELECT id, key, name FROM request_forms
        WHERE (key=$1 OR id::text=$1) AND (organization_id IS NULL OR organization_id=$2)
        ORDER BY (organization_id IS NULL) LIMIT 1`,
      [key, orgId],
    )
  ).rows[0];
  if (!form) return { id: null as string | null, key, name: null as string | null, fields: [] as FieldDef[] };
  const { rows } = await sql.query(
    `SELECT key, label, data_type, options, maps_to, visible_when, sensitive, section, required, options_source
       FROM form_fields WHERE form_id=$1 ORDER BY position`,
    [form.id],
  );
  const fields: FieldDef[] = rows.map((r: any) => ({
    key: r.key, label: r.label, data_type: r.data_type, options: r.options ?? [], maps_to: r.maps_to ?? null,
    visible_when: r.visible_when ?? null, sensitive: !!r.sensitive, section: r.section ?? null,
    required: !!r.required, options_source: r.options_source ?? null,
  }));
  return { id: form.id as string, key: form.key as string, name: form.name as string, fields };
}

/**
 * GET /tickets/:id/form. Nexus-plane staff only; the ticket must be readable by the caller
 * through the ordinary getTicket path (RLS + object-level checks), which is what throws 404/403.
 * Everything after that check reads config and user names in system context.
 */
export async function getTicketForm(
  actor: Principal,
  ticketId: string,
  opts: { includePii?: boolean } = {},
): Promise<SubmittedForm> {
  if (actor.plane !== 'nexus') throw Errors.forbidden('submitted forms are visible to service staff only');
  const t = await getTicket(actor, ticketId);
  const ticket = {
    status: t.status as string,
    description: (t.description as string | null) ?? null,
    requester_id: (t.requester_id as string | null) ?? null,
    affected_user_id: (t.affected_user_id as string | null) ?? null,
    custom_fields: (t.custom_fields as Record<string, unknown> | null) ?? {},
  };
  const formRef = typeof ticket.custom_fields._form === 'string' ? (ticket.custom_fields._form as string) : null;

  const loaded = await withSystemContext(async (sql) => {
    const form = await loadFormDefs(sql, formRef, (t.category as string | null) ?? null, t.organization_id);
    const fields = form?.fields ?? [];
    const approvers = (
      await sql.query(
        `SELECT s.approver_id, u.display_name AS name, u.email,
                COALESCE(s.decision, CASE WHEN a.status='requested' THEN 'pending' ELSE a.status END) AS status
           FROM approvals a JOIN approval_steps s ON s.approval_id=a.id
           LEFT JOIN users u ON u.id=s.approver_id
          WHERE a.subject_id=$1 ORDER BY a.created_at, s.step_order`,
        [ticketId],
      )
    ).rows;
    const ids = userIdsToResolve(fields, ticket);
    for (const a of approvers) if (a.approver_id) ids.push(a.approver_id);
    const users = new Map<string, UserRef>();
    if (ids.length) {
      const { rows } = await sql.query('SELECT id, display_name, email FROM users WHERE id = ANY($1::uuid[])', [[...new Set(ids)]]);
      for (const r of rows) users.set(r.id, { id: r.id, name: r.display_name ?? null, email: r.email ?? null });
    }
    // Keys only — which PII fields hold a value. Values are read (and audited) below, if at all.
    const sensitiveKeys = (
      await sql.query('SELECT key FROM ticket_sensitive_fields WHERE ticket_id=$1', [ticketId])
    ).rows.map((r: { key: string }) => r.key);
    const runs = await loadRunsForEdit(sql, ticketId);
    return { form, fields, approvers, users, sensitiveKeys, runs };
  });

  let sensitiveValues: Record<string, string> | null = null;
  if (
    opts.includePii &&
    loaded.sensitiveKeys.length > 0 &&
    can(actor, 'pii.view', { organizationId: t.organization_id })
  ) {
    sensitiveValues = await readSensitive(actor, ticketId); // writes the pii.viewed audit entry
  }

  return shapeSubmittedForm({
    formKey: loaded.form?.key ?? formRef,
    formName: loaded.form?.name ?? null,
    fields: loaded.fields,
    ticket,
    approvers: loaded.approvers,
    users: loaded.users,
    sensitiveKeys: loaded.sensitiveKeys,
    sensitiveValues,
    runs: loaded.runs,
  });
}

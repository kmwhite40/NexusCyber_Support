// Correcting the answers on a submitted catalog request (PATCH /tickets/:id/form).
//
// A request filed with the wrong name, supervisor, groups or start date used to be fixable only by
// cancelling it and filing again (losing its approvals and history) or by hand in the database.
// This lets a holder of `ticket.form.edit` change individual answers in place, with the SAME rules
// the original submission was held to and a record of exactly what changed.
//
// The rules, and why:
//   - Partial: only the keys sent change. Each is validated against THIS ticket's own form
//     definition (loadFormDefs — the one GET displays), with the submission validator. Required
//     fields cannot be emptied; a conditional field cannot be set while its condition is unmet; a
//     field whose condition stops holding has its old answer removed, exactly as submission drops
//     hidden answers.
//   - Mapped answers land where they actually live: subject is recomposed from the name fields,
//     description/requester/affected update their columns, manager stays in custom_fields.
//   - User answers must name a person of the ticket's organization (or staff scoped to it).
//   - PII is written only through the sensitive store, only by a pii.view holder, and never
//     appears in the comment or the audit entry — those say "changed", not the value.
//   - Approvers are never editable here: decisions already recorded must not silently change.
//   - Frozen while a provisioning/offboarding run is in flight, on resolved/closed tickets, and —
//     once the account exists — for the name fields the UPN was derived from (ticket-form.ts
//     editGuards, shared with GET so the UI and the API agree on what is editable).
//
// Editing onboarding answers changes the provisioning plan fingerprint. That is intended: the
// fingerprint is recomputed from current data on every preview and execute (planner.ts
// planFingerprint) and is not cached anywhere, so a preview taken before an edit is refused with
// 412 at execute and must be refreshed.
import { withOrgContext, withSystemContext, type Sql } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { ApiError, Errors } from '../errors.js';
import { validateAgainstForm, type ValidationError } from './forms.js';
import { isFieldVisible, type FormField } from './form-fields.js';
import { storeSensitiveWith } from './sensitive-fields.js';
import {
  editGuards, getTicketForm, isEmpty, loadFormDefs, loadRunsForEdit, toArray, userLabel,
  type FieldDef, type SubmittedForm, type UserRef,
} from './ticket-form.js';
import type { Principal } from '../types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_TYPES = new Set(['user', 'user_multi']);
const MULTI_TYPES = new Set(['multiselect', 'user_multi']);
/** Stand-in for a stored PII answer in the reassembled answer set. The planner never reads the
 *  sensitive store's values: it only needs to know an answer exists (required/visibility). */
const STORED_PII = Symbol('stored-pii');

export interface FieldChange {
  key: string;
  label: string;
  data_type: string;
  sensitive: boolean;
  /** Old/new values. Always null for sensitive fields — they are never carried out of here. */
  from: unknown;
  to: unknown;
  /** True when the answer was removed because its field's condition no longer holds. */
  removed?: boolean;
}

export interface EditTicketInput {
  status: string;
  subject: string;
  description: string | null;
  requester_id: string | null;
  affected_user_id: string | null;
  custom_fields: Record<string, unknown>;
}

export interface EditPlan {
  /** 422: the answers are invalid. */
  errors: ValidationError[];
  /** 409: the answers are fine but the field cannot be changed on this ticket. */
  conflicts: ValidationError[];
  changes: FieldChange[];
  /** Column/custom_fields values to write. Only keys that change are present. */
  update: {
    custom_fields: Record<string, unknown>;
    subject?: string;
    description?: string | null;
    requester_id?: string | null;
    affected_user_id?: string | null;
  };
  sensitiveSet: Record<string, unknown>;
  sensitiveDelete: string[];
  /** User ids a changed answer newly references — the caller must prove each is in the org. */
  userIds: Array<{ key: string; id: string }>;
}

function toFormField(f: FieldDef): FormField {
  return {
    key: f.key, label: f.label, data_type: f.data_type as FormField['data_type'], required: !!f.required,
    options: f.options ?? [], maps_to: f.maps_to, visible_when: f.visible_when ?? null,
    sensitive: !!f.sensitive, options_source: f.options_source ?? null, section: f.section ?? null,
  };
}

function norm(v: unknown, dataType: string, key: string): unknown {
  if (isEmpty(v)) return null;
  if (MULTI_TYPES.has(dataType) || key === 'security_groups' || Array.isArray(v)) {
    const a = toArray(v);
    return a.length ? a : null;
  }
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Decide everything an edit writes. Pure — the caller supplies the locked ticket row, the form,
 * which PII keys are stored, and the edit guards; this returns errors or the exact writes.
 */
export function planFormEdit(input: {
  fields: FieldDef[];
  ticket: EditTicketInput;
  sensitiveKeys: string[];
  patch: Record<string, unknown>;
  locked: Record<string, string>;
}): EditPlan {
  const { ticket, patch, locked } = input;
  const fields = input.fields.map(toFormField);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const cf: Record<string, unknown> = { ...(ticket.custom_fields ?? {}) };
  const stored = new Set(input.sensitiveKeys);
  const hasAffectedField = fields.some((f) => f.maps_to === 'affected');

  const plan: EditPlan = {
    errors: [], conflicts: [], changes: [], update: { custom_fields: cf },
    sensitiveSet: {}, sensitiveDelete: [], userIds: [],
  };

  // The answers as they stand, reassembled the way GET shows them.
  const current: Record<string, unknown> = { ...cf };
  for (const f of fields) {
    if (f.sensitive) { if (stored.has(f.key)) current[f.key] = STORED_PII; continue; }
    if (f.key in cf) continue;
    if (f.maps_to === 'description' && ticket.description) current[f.key] = ticket.description;
    else if (f.maps_to === 'requester' && ticket.requester_id) current[f.key] = ticket.requester_id;
    else if (f.maps_to === 'affected' && ticket.affected_user_id) current[f.key] = ticket.affected_user_id;
  }

  // Which keys may be touched at all.
  const accepted: FormField[] = [];
  for (const key of Object.keys(patch)) {
    const f = byKey.get(key);
    if (!f) { plan.errors.push({ field: key, message: `${key} is not a field on this request's form` }); continue; }
    if (locked[key]) { plan.conflicts.push({ field: key, message: `${f.label}: ${locked[key]}` }); continue; }
    accepted.push(f);
  }

  const merged: Record<string, unknown> = { ...current };
  for (const f of accepted) {
    const v = patch[f.key];
    if (isEmpty(v)) delete merged[f.key];
    else merged[f.key] = typeof v === 'string' ? v.trim() : v;
    if (isEmpty(merged[f.key])) delete merged[f.key];
  }

  const visibleBefore = (f: FormField) => isFieldVisible(f, current);
  const visibleAfter = (f: FormField) => isFieldVisible(f, merged);
  const patched = new Set(accepted.map((f) => f.key));

  for (const f of accepted) {
    if (!(f.key in merged)) {
      // The requester column is NOT NULL-in-practice for a request; clearing it would orphan it.
      if (f.maps_to === 'requester') plan.errors.push({ field: f.key, message: `${f.label} cannot be cleared` });
      continue;
    }
    if (!visibleAfter(f)) {
      plan.errors.push({ field: f.key, message: `${f.label} does not apply to this request (its condition is not met)` });
    }
    if (USER_TYPES.has(f.data_type)) {
      for (const id of toArray(merged[f.key])) {
        if (typeof id !== 'string' || !UUID.test(id)) {
          plan.errors.push({ field: f.key, message: `${f.label} must be a user` });
          break;
        }
      }
    }
  }

  // The submission validator, over the merged answers. Only errors this edit is responsible for
  // count: a field it changed, or one it made visible (e.g. switching to Temporary now requires
  // an end date). Pre-existing oddities in untouched answers do not block a correction elsewhere.
  // Stored PII is represented by a placeholder, so its type checks are skipped unless patched.
  const forValidation: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) forValidation[k] = v === STORED_PII ? '__stored__' : v;
  for (const e of validateAgainstForm(fields, forValidation).errors) {
    const f = byKey.get(e.field)!;
    if (patched.has(e.field) || (!visibleBefore(f) && visibleAfter(f))) {
      if (!plan.errors.some((x) => x.field === e.field && x.message === e.message)) plan.errors.push(e);
    }
  }
  if (plan.errors.length || plan.conflicts.length) return plan;

  const record = (f: FormField, from: unknown, to: unknown, removed = false) =>
    plan.changes.push({
      key: f.key, label: f.label, data_type: f.data_type, sensitive: f.sensitive,
      from: f.sensitive ? null : from, to: f.sensitive ? null : to, ...(removed ? { removed: true } : {}),
    });

  let subjectTouched = false;
  for (const f of accepted) {
    const to = norm(merged[f.key], f.data_type, f.key);
    if (f.sensitive) {
      if (to === null) {
        if (!stored.has(f.key)) continue;
        plan.sensitiveDelete.push(f.key);
      } else {
        plan.sensitiveSet[f.key] = to;
      }
      record(f, null, null);
      continue;
    }
    const from = norm(current[f.key], f.data_type, f.key);
    if (same(from, to)) continue;
    record(f, from, to);
    switch (f.maps_to) {
      case 'description':
        plan.update.description = to === null ? null : String(to);
        break;
      case 'requester':
        plan.update.requester_id = String(to);
        if (!hasAffectedField) plan.update.affected_user_id = String(to);
        break;
      case 'affected':
        plan.update.affected_user_id = to === null ? null : String(to);
        if (to === null) delete cf[f.key]; else cf[f.key] = to;
        break;
      case 'subject':
        subjectTouched = true;
        if (to === null) delete cf[f.key]; else cf[f.key] = to;
        break;
      default: // 'manager' and unmapped answers live in custom_fields
        if (to === null) delete cf[f.key]; else cf[f.key] = to;
    }
  }

  // People this edit newly references. Only those need proving to be in the org: an unchanged
  // answer is not being asserted afresh.
  for (const c of plan.changes) {
    if (!USER_TYPES.has(c.data_type) || c.sensitive) continue;
    const before = new Set(toArray(c.from));
    for (const id of toArray(c.to)) if (typeof id === 'string' && !before.has(id)) plan.userIds.push({ key: c.key, id });
  }

  // Answers whose field this edit hid are removed, as submission would never have stored them.
  for (const f of fields) {
    if (patched.has(f.key) || !visibleBefore(f) || visibleAfter(f)) continue;
    if (f.sensitive) {
      if (stored.has(f.key)) { plan.sensitiveDelete.push(f.key); record(f, null, null, true); }
      continue;
    }
    if (f.key in cf && !isEmpty(cf[f.key])) {
      record(f, norm(cf[f.key], f.data_type, f.key), null, true);
      delete cf[f.key];
      if (f.maps_to === 'subject') subjectTouched = true;
    }
  }

  if (subjectTouched) {
    const parts = fields
      .filter((f) => f.maps_to === 'subject' && !f.sensitive && isFieldVisible(f, merged) && !isEmpty(cf[f.key]))
      .map((f) => String(cf[f.key]));
    const subject = parts.join(' ');
    if (subject && subject !== ticket.subject) plan.update.subject = subject;
  }
  return plan;
}

/** Render a change for the internal comment. User ids become names. Pure. */
export function describeChange(c: FieldChange, users: Map<string, UserRef>): string {
  if (c.sensitive) return c.removed ? `${c.label}: removed (no longer applies)` : `${c.label}: changed`;
  const show = (v: unknown): string => {
    if (v === null || v === undefined) return '(blank)';
    if (Array.isArray(v)) return v.length ? v.map((x) => show(x)).join(', ') : '(blank)';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'string' && USER_TYPES.has(c.data_type) && users.has(v)) return userLabel(users.get(v), v);
    return String(v);
  };
  if (c.removed) return `${c.label}: ${show(c.from)} → removed (no longer applies)`;
  return `${c.label}: ${show(c.from)} → ${show(c.to)}`;
}

/** Is each referenced user a person of this org — a customer-plane user of the org, or staff
 *  whose role assignments reach it (org-scoped or all-orgs)? Returns the ids that are NOT. */
async function usersOutsideOrg(sql: Sql, ids: string[], orgId: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await sql.query(
    `SELECT u.id FROM users u
      WHERE u.id = ANY($1::uuid[])
        AND (u.organization_id = $2
             OR (u.plane = 'nexus' AND EXISTS (
                   SELECT 1 FROM role_assignments ra
                    WHERE ra.user_id = u.id
                      AND (ra.organization_id = $2 OR ra.organization_id IS NULL)
                      AND (ra.expires_at IS NULL OR ra.expires_at > now()))))`,
    [ids, orgId],
  );
  const ok = new Set(rows.map((r: { id: string }) => r.id));
  return new Set(ids.filter((id) => !ok.has(id)));
}

function refuse(plan: Pick<EditPlan, 'errors' | 'conflicts'>): never {
  if (plan.errors.length) {
    throw Errors.validation(plan.errors.map((e) => e.message).join('; '), plan.errors);
  }
  throw new ApiError(409, 'Conflict', plan.conflicts.map((e) => e.message).join('; '), 'conflict', plan.conflicts);
}

/**
 * PATCH /tickets/:id/form. Returns the refreshed form (same shape as GET).
 */
export async function editTicketForm(
  actor: Principal,
  ticketId: string,
  patch: Record<string, unknown>,
  opts: { reason?: string | null; includePii?: boolean } = {},
): Promise<SubmittedForm> {
  if (actor.plane !== 'nexus') throw Errors.forbidden('submitted forms are edited by service staff only');
  if (!patch || Object.keys(patch).length === 0) throw Errors.badRequest('no answers to change');

  // Scope check first (RLS + PDP), before any config is read in system context.
  const head = await withOrgContext(orgContextFor(actor), async (sql) =>
    (await sql.query('SELECT organization_id, category, custom_fields FROM tickets WHERE id=$1', [ticketId])).rows[0],
  );
  if (!head) throw Errors.notFound('ticket not found');
  const orgId: string = head.organization_id;
  authorize(actor, 'ticket.form.edit', { organizationId: orgId });

  const formRef = typeof head.custom_fields?._form === 'string' ? (head.custom_fields._form as string) : null;
  const form = await withSystemContext((sql) => loadFormDefs(sql, formRef, head.category ?? null, orgId));
  if (!form || form.fields.length === 0) throw Errors.conflict('this ticket has no submitted request form to edit');

  // PII answers need pii.view on top of ticket.form.edit — you may not overwrite what you may not read.
  const sensitiveInPatch = form.fields.filter((f) => f.sensitive && f.key in patch).map((f) => f.key);
  if (sensitiveInPatch.length) authorize(actor, 'pii.view', { organizationId: orgId });

  const reason = opts.reason?.trim() || null;

  await withOrgContext(orgContextFor(actor), async (sql) => {
    // Lock the row: two concurrent edits must not each merge into the same stale custom_fields.
    const t = (
      await sql.query(
        `SELECT id, organization_id, status, subject, description, requester_id, affected_user_id, custom_fields
           FROM tickets WHERE id=$1 FOR UPDATE`,
        [ticketId],
      )
    ).rows[0];
    if (!t) throw Errors.notFound('ticket not found');

    const runs = await loadRunsForEdit(sql, ticketId);
    const guards = editGuards(t.status, runs, form.fields);
    if (guards.blocked) throw Errors.conflict(guards.blocked);

    const sensitiveKeys = (
      await sql.query('SELECT key FROM ticket_sensitive_fields WHERE ticket_id=$1', [ticketId])
    ).rows.map((r: { key: string }) => r.key);

    const plan = planFormEdit({
      fields: form.fields,
      ticket: {
        status: t.status, subject: t.subject, description: t.description ?? null,
        requester_id: t.requester_id ?? null, affected_user_id: t.affected_user_id ?? null,
        custom_fields: t.custom_fields ?? {},
      },
      sensitiveKeys,
      patch,
      locked: guards.locked,
    });
    if (plan.errors.length || plan.conflicts.length) refuse(plan);

    // Every referenced person must belong to this ticket's organization. Checked in system
    // context: staff users are org-NULL and invisible to tenant RLS.
    const ids = [...new Set(plan.userIds.map((u) => u.id))];
    const outside = await withSystemContext((s) => usersOutsideOrg(s, ids, orgId));
    if (outside.size) {
      const labels = new Map(form.fields.map((f) => [f.key, f.label]));
      const errs = [...new Set(plan.userIds.filter((u) => outside.has(u.id)).map((u) => u.key))]
        .map((key) => ({ field: key, message: `${labels.get(key) ?? key} must be a person in this ticket's organization` }));
      refuse({ errors: errs, conflicts: [] });
    }

    if (plan.changes.length === 0) return; // nothing actually differs — no write, no noise

    const u = plan.update;
    await sql.query(
      `UPDATE tickets SET
          custom_fields = $2::jsonb,
          subject = COALESCE($3, subject),
          description = CASE WHEN $4 THEN $5 ELSE description END,
          requester_id = CASE WHEN $6 THEN $7::uuid ELSE requester_id END,
          affected_user_id = CASE WHEN $8 THEN $9::uuid ELSE affected_user_id END,
          last_internal_update_at = now()
        WHERE id = $1`,
      [
        ticketId, JSON.stringify(u.custom_fields), u.subject ?? null,
        'description' in u, u.description ?? null,
        'requester_id' in u, u.requester_id ?? null,
        'affected_user_id' in u, u.affected_user_id ?? null,
      ],
    );
    await storeSensitiveWith(sql, ticketId, orgId, plan.sensitiveSet);
    if (plan.sensitiveDelete.length) {
      await sql.query('DELETE FROM ticket_sensitive_fields WHERE ticket_id=$1 AND key = ANY($2::text[])', [ticketId, plan.sensitiveDelete]);
    }

    // Names for the comment (old and new people alike).
    const nameIds = new Set<string>();
    for (const c of plan.changes) {
      if (!USER_TYPES.has(c.data_type)) continue;
      for (const v of [...toArray(c.from), ...toArray(c.to)]) if (typeof v === 'string' && UUID.test(v)) nameIds.add(v);
    }
    const users = new Map<string, UserRef>();
    if (nameIds.size) {
      const rows = await withSystemContext(async (s) =>
        (await s.query('SELECT id, display_name, email FROM users WHERE id = ANY($1::uuid[])', [[...nameIds]])).rows,
      );
      for (const r of rows) users.set(r.id, { id: r.id, name: r.display_name ?? null, email: r.email ?? null });
    }

    const lines = plan.changes.map((c) => `- ${describeChange(c, users)}`);
    const body = [
      'Submitted request form edited.',
      reason ? `Reason: ${reason}` : null,
      ...lines,
    ].filter(Boolean).join('\n');
    await sql.query(
      `INSERT INTO ticket_comments (organization_id, ticket_id, author_id, visibility, body)
       VALUES ($1,$2,$3,'internal',$4)`,
      [orgId, ticketId, actor.id, body],
    );
    await sql.query(
      `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
       VALUES ($1,$2,$3,'form_edited',$4)`,
      [orgId, ticketId, actor.id, { fields: plan.changes.map((c) => c.key), reason }],
    );
    // Last, still inside the transaction: if the audit write fails the edit rolls back, so an
    // edit can never land unaudited. Values for sensitive fields are never included.
    await audit(actor, {
      action: 'ticket.form.edited',
      organizationId: orgId,
      resourceType: 'ticket',
      resourceId: ticketId,
      detail: {
        reason,
        changes: plan.changes.map((c) =>
          c.sensitive
            ? { key: c.key, label: c.label, sensitive: true, changed: true, ...(c.removed ? { removed: true } : {}) }
            : { key: c.key, label: c.label, from: c.from, to: c.to, ...(c.removed ? { removed: true } : {}) },
        ),
      },
    });
  });

  return getTicketForm(actor, ticketId, { includePii: opts.includePii });
}

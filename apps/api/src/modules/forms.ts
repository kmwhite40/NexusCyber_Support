// Custom request forms & field definitions (JSM parity). Forms describe typed fields;
// submitted answers are validated and merged into a ticket's custom_fields jsonb.
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize, can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date'
  | 'user' | 'user_multi' | 'attachment';

export interface FormField {
  key: string;
  label: string;
  data_type: FieldType;
  required: boolean;
  options: string[];
  maps_to: string | null;
}

export interface ValidationError {
  field: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate answers against a form's field definitions. Pure. */
export function validateAgainstForm(fields: FormField[], answers: Record<string, unknown>): { ok: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  for (const f of fields) {
    if (f.data_type === 'attachment') continue;
    const v = answers[f.key];
    const missing =
      v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (missing) {
      if (f.required) errors.push({ field: f.key, message: `${f.label} is required` });
      continue;
    }
    switch (f.data_type) {
      case 'number':
        if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))) {
          errors.push({ field: f.key, message: `${f.label} must be a number` });
        }
        break;
      case 'select':
        if (!f.options.includes(String(v))) errors.push({ field: f.key, message: `${f.label} must be one of: ${f.options.join(', ')}` });
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') errors.push({ field: f.key, message: `${f.label} must be true or false` });
        break;
      case 'date':
        if (typeof v !== 'string' || !ISO_DATE.test(v)) errors.push({ field: f.key, message: `${f.label} must be a date (YYYY-MM-DD)` });
        break;
      case 'user':
        if (typeof v !== 'string') errors.push({ field: f.key, message: `${f.label} must be a user` });
        break;
      case 'user_multi':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push({ field: f.key, message: `${f.label} must be a list of users` });
        break;
    }
  }
  return { ok: errors.length === 0, errors };
}

function canManageForms(actor: Principal): boolean {
  return can(actor, 'automation.author') || can(actor, 'customer.admin.manage_users');
}

export async function listForms(actor: Principal) {
  authorize(actor, 'ticket.create');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT f.id, f.organization_id, f.key, f.name, f.ticket_type, f.active,
              (SELECT count(*)::int FROM form_fields ff WHERE ff.form_id=f.id) AS field_count
         FROM request_forms f WHERE f.active ORDER BY f.name`,
    );
    return rows;
  });
}

async function loadFields(sql: import('../db/pool.js').Sql, formId: string): Promise<FormField[]> {
  const { rows } = await sql.query(
    'SELECT key, label, data_type, required, options, maps_to FROM form_fields WHERE form_id=$1 ORDER BY position',
    [formId],
  );
  return rows.map((r) => ({
    key: r.key, label: r.label, data_type: r.data_type, required: r.required,
    options: (r.options as string[]) ?? [], maps_to: r.maps_to ?? null,
  }));
}

export async function getForm(actor: Principal, id: string) {
  authorize(actor, 'ticket.create');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const form = (await sql.query('SELECT * FROM request_forms WHERE id=$1', [id])).rows[0];
    if (!form) throw Errors.notFound('form not found');
    const fields = await loadFields(sql, id);
    return { ...form, fields };
  });
}

/** Resolve the form linked to a catalog item (service_catalog_items.form_key). Null when none. */
export async function getFormByCatalogKey(actor: Principal, catalogKey: string) {
  authorize(actor, 'ticket.create');
  return withSystemContext(async (sql) => {
    const item = (
      await sql.query('SELECT form_key FROM service_catalog_items WHERE key=$1 AND active', [catalogKey])
    ).rows[0];
    if (!item?.form_key) return null;
    const form = (
      await sql.query('SELECT * FROM request_forms WHERE key=$1 AND organization_id IS NULL AND active', [item.form_key])
    ).rows[0];
    if (!form) return null;
    const fields = await loadFields(sql, form.id);
    return { ...form, fields };
  });
}

export async function createForm(actor: Principal, input: { key: string; name: string; ticketType?: string }) {
  if (!canManageForms(actor)) throw Errors.forbidden('not permitted to manage forms');
  const orgId = actor.plane === 'customer' ? actor.organizationId : null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO request_forms (organization_id, key, name, ticket_type, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.key, input.name, input.ticketType ?? null, actor.id],
    );
    await audit(actor, { action: 'form.create', organizationId: orgId, resourceType: 'request_form', resourceId: rows[0].id, detail: { key: input.key } });
    return rows[0];
  });
}

export async function addField(actor: Principal, formId: string, field: { key: string; label: string; dataType?: FieldType; required?: boolean; options?: string[]; position?: number }) {
  if (!canManageForms(actor)) throw Errors.forbidden('not permitted to manage forms');
  return withSystemContext(async (sql) => {
    const form = (await sql.query('SELECT id FROM request_forms WHERE id=$1', [formId])).rows[0];
    if (!form) throw Errors.notFound('form not found');
    const { rows } = await sql.query(
      `INSERT INTO form_fields (form_id, key, label, data_type, required, options, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
         required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position RETURNING *`,
      [formId, field.key, field.label, field.dataType ?? 'text', field.required ?? false, JSON.stringify(field.options ?? []), field.position ?? 0],
    );
    await audit(actor, { action: 'form.add_field', resourceType: 'request_form', resourceId: formId, detail: { field: field.key } });
    return rows[0];
  });
}

export interface MappedAnswers {
  subject?: string;
  description?: string;
  requesterId?: string;
  affectedUserId?: string;
  customFields: Record<string, unknown>;
  approverIds: string[];
}

/** Route a form's answers to ticket columns, approval steps, and custom_fields. Pure. */
export function mapFormAnswers(
  fields: FormField[],
  answers: Record<string, unknown>,
  opts: { defaultRequesterId?: string | null } = {},
): MappedAnswers {
  const out: MappedAnswers = { customFields: {}, approverIds: [] };
  for (const f of fields) {
    const v = answers[f.key];
    switch (f.maps_to) {
      case 'subject':
        if (v) out.subject = String(v);
        break;
      case 'description':
        if (v) out.description = String(v);
        break;
      case 'requester':
        if (v) { out.requesterId = String(v); out.affectedUserId = String(v); }
        break;
      case 'affected':
        // The person the request is ABOUT (e.g. offboarding) when that differs from
        // the requester. Sets affected-user only; requester falls back to the submitter.
        if (v) { out.affectedUserId = String(v); out.customFields[f.key] = v; }
        break;
      case 'approvers':
        if (Array.isArray(v)) out.approverIds = v.map(String).filter(Boolean);
        break;
      case 'attachment':
        break; // file handled out of band
      case 'manager':
        if (v) out.customFields[f.key] = v; // recorded; also available as custom field
        break;
      default:
        if (v !== undefined && v !== null && v !== '') out.customFields[f.key] = v;
    }
  }
  if (!out.requesterId && opts.defaultRequesterId) {
    out.requesterId = opts.defaultRequesterId;
    if (!out.affectedUserId) out.affectedUserId = opts.defaultRequesterId;
  }
  return out;
}

/** Validate answers against a form and merge them into a ticket's custom_fields. */
export async function submitAnswers(actor: Principal, ticketId: string, formId: string, answers: Record<string, unknown>) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT organization_id, custom_fields FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.update', { organizationId: t.organization_id });
    const fields = await loadFields(sql, formId);
    if (fields.length === 0) throw Errors.notFound('form not found or has no fields');
    const result = validateAgainstForm(fields, answers);
    if (!result.ok) throw Errors.validation(result.errors.map((e) => e.message).join('; '));
    const merged = { ...(t.custom_fields ?? {}), ...answers, _form: formId };
    await sql.query('UPDATE tickets SET custom_fields=$1 WHERE id=$2', [JSON.stringify(merged), ticketId]);
    await audit(actor, { action: 'form.submit', organizationId: t.organization_id, resourceType: 'ticket', resourceId: ticketId, detail: { form: formId } });
    return { ok: true, custom_fields: merged };
  });
}

import { describe, it, expect } from 'vitest';
import { planFormEdit, describeChange, type EditTicketInput } from '../src/modules/ticket-form-edit.js';
import { editGuards, formAnswersRefusal, APPROVERS_LOCKED, type FieldDef } from '../src/modules/ticket-form.js';

// The decision logic behind PATCH /tickets/:id/form is pure and pinned here; the DB-backed path
// (permission, org check, transaction, comment + audit) is covered by
// test/integration/ticket-form-edit.int.test.ts.

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

const f = (key: string, over: Partial<FieldDef> = {}): FieldDef => ({
  key, label: key, data_type: 'text', maps_to: null, visible_when: null, sensitive: false, section: null,
  required: false, options: [], options_source: null, ...over,
});

const FIELDS: FieldDef[] = [
  f('on_behalf_of', { label: 'On behalf of', data_type: 'user', maps_to: 'requester', required: true }),
  f('start_date', { label: 'Start date', data_type: 'date', required: true }),
  f('legal_first_name', { label: 'Legal first name', maps_to: 'subject', required: true }),
  f('legal_last_name', { label: 'Legal last name', maps_to: 'subject', required: true }),
  f('personal_email', { label: 'Personal email', data_type: 'email', sensitive: true }),
  f('access_type', { label: 'Access type', data_type: 'select', options: ['Permanent', 'Temporary'], required: true }),
  f('end_date', { label: 'End date', data_type: 'date', required: true, visible_when: { field: 'access_type', equals: 'Temporary' } }),
  f('work_location', { label: 'Work location', data_type: 'select', options: ['WFH', 'On Site'] }),
  f('home_address', { label: 'Home address', sensitive: true, visible_when: { field: 'work_location', equals: 'WFH' } }),
  f('supervisor', { label: 'Supervisor', data_type: 'user', maps_to: 'manager', required: true }),
  f('security_groups', { label: 'Groups', data_type: 'multiselect', options_source: 'entra_groups' }),
  f('notes', { label: 'Notes', data_type: 'textarea', maps_to: 'description' }),
  f('approvers', { label: 'Approvers', data_type: 'user_multi', maps_to: 'approvers' }),
];

const ticket = (over: Partial<EditTicketInput> = {}): EditTicketInput => ({
  status: 'in_progress',
  subject: 'Grace Hopper',
  description: 'old notes',
  requester_id: U1,
  affected_user_id: U1,
  custom_fields: {
    _form: 'user_onboarding', start_date: '2026-10-01', legal_first_name: 'Grace', legal_last_name: 'Hopper',
    access_type: 'Permanent', work_location: 'WFH', supervisor: U1, security_groups: ['A'],
  },
  ...over,
});

const plan = (patch: Record<string, unknown>, over: { sensitiveKeys?: string[]; locked?: Record<string, string>; t?: Partial<EditTicketInput> } = {}) =>
  planFormEdit({
    fields: FIELDS, ticket: ticket(over.t), sensitiveKeys: over.sensitiveKeys ?? ['personal_email', 'home_address'],
    patch, locked: over.locked ?? editGuards('in_progress', [], FIELDS).locked,
  });

describe('planFormEdit', () => {
  it('changes only the keys sent and recomposes the subject from the name fields', () => {
    const p = plan({ legal_first_name: 'Grayce' });
    expect(p.errors).toEqual([]);
    expect(p.update.subject).toBe('Grayce Hopper');
    expect(p.update.custom_fields.legal_first_name).toBe('Grayce');
    expect(p.update.custom_fields.start_date).toBe('2026-10-01');
    expect(p.update).not.toHaveProperty('description');
    expect(p.changes).toEqual([expect.objectContaining({ key: 'legal_first_name', from: 'Grace', to: 'Grayce' })]);
  });

  it('routes description and requester to their columns, not custom_fields', () => {
    const p = plan({ notes: 'new notes', on_behalf_of: U2 });
    expect(p.update.description).toBe('new notes');
    expect(p.update.requester_id).toBe(U2);
    expect(p.update.affected_user_id).toBe(U2); // no 'affected' field on this form, as at submission
    expect(p.update.custom_fields).not.toHaveProperty('notes');
    expect(p.update.custom_fields).not.toHaveProperty('on_behalf_of');
    expect(p.userIds).toEqual([{ key: 'on_behalf_of', id: U2 }]);
  });

  it('keeps the manager-mapped supervisor in custom_fields and lists only NEW people for the org check', () => {
    const p = plan({ supervisor: U2 });
    expect(p.update.custom_fields.supervisor).toBe(U2);
    expect(p.userIds).toEqual([{ key: 'supervisor', id: U2 }]);
    expect(plan({ supervisor: U1 }).userIds).toEqual([]); // unchanged: no change, nothing to prove
    expect(plan({ supervisor: U1 }).changes).toEqual([]);
  });

  it('refuses a non-UUID user answer', () => {
    expect(plan({ supervisor: 'bob' }).errors).toEqual([expect.objectContaining({ field: 'supervisor', message: 'Supervisor must be a user' })]);
  });

  it('refuses emptying a required field, bad types and unknown options — with the submission validator', () => {
    expect(plan({ legal_last_name: '' }).errors).toEqual([expect.objectContaining({ field: 'legal_last_name', message: 'Legal last name is required' })]);
    expect(plan({ start_date: 'soon' }).errors[0].field).toBe('start_date');
    expect(plan({ access_type: 'Forever' }).errors[0].field).toBe('access_type');
    expect(plan({ on_behalf_of: null }).errors[0].message).toMatch(/cannot be cleared|required/);
  });

  it('accepts a live-sourced multiselect value the static list does not know (as at submission)', () => {
    const p = plan({ security_groups: ['A', 'B'] });
    expect(p.errors).toEqual([]);
    expect(p.update.custom_fields.security_groups).toEqual(['A', 'B']);
  });

  it('requires a field the edit makes visible, and refuses setting one whose condition is unmet', () => {
    expect(plan({ access_type: 'Temporary' }).errors).toEqual([expect.objectContaining({ field: 'end_date' })]);
    expect(plan({ access_type: 'Temporary', end_date: '2027-01-01' }).errors).toEqual([]);
    expect(plan({ end_date: '2027-01-01' }).errors).toEqual([expect.objectContaining({ field: 'end_date', message: expect.stringMatching(/does not apply/) })]);
  });

  it('removes answers whose condition the edit turns off — including stored PII', () => {
    const p = plan({ work_location: 'On Site' });
    expect(p.errors).toEqual([]);
    expect(p.sensitiveDelete).toEqual(['home_address']);
    expect(p.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'home_address', sensitive: true, removed: true, from: null, to: null }),
    ]));
  });

  it('writes PII only to the sensitive bag and never carries its value in the change record', () => {
    const p = plan({ personal_email: 'new@personal.example' });
    expect(p.sensitiveSet).toEqual({ personal_email: 'new@personal.example' });
    expect(p.update.custom_fields).not.toHaveProperty('personal_email');
    expect(JSON.stringify(p.changes)).not.toContain('new@personal.example');
    expect(plan({ personal_email: 'nope' }).errors[0].field).toBe('personal_email');
  });

  it('does not trip on stored PII placeholders when an unrelated field is edited', () => {
    expect(plan({ start_date: '2026-11-01' }).errors).toEqual([]);
  });

  it('refuses unknown keys (422) and locked keys (409 conflicts), approvers always locked', () => {
    expect(plan({ nope: 1 }).errors[0].message).toMatch(/not a field/);
    const p = plan({ approvers: [U2] });
    expect(p.conflicts).toEqual([expect.objectContaining({ field: 'approvers', message: expect.stringContaining(APPROVERS_LOCKED) })]);
  });

  it('is a no-op when nothing actually changes', () => {
    const p = plan({ legal_first_name: 'Grace', start_date: '2026-10-01' });
    expect(p.changes).toEqual([]);
    expect(p.update).not.toHaveProperty('subject');
  });
});

describe('editGuards', () => {
  const fields = FIELDS;
  it('blocks resolved/closed tickets', () => {
    expect(editGuards('resolved', [], fields).blocked).toMatch(/resolved/);
    expect(editGuards('closed', [], fields).blocked).toMatch(/closed/);
    expect(editGuards('in_progress', [], fields).blocked).toBeNull();
  });

  it('blocks while an onboarding run is running or awaiting its Cloud PC', () => {
    expect(editGuards('in_progress', [{ kind: 'onboarding', status: 'running' }], fields).blocked).toMatch(/provisioning is in progress/);
    expect(editGuards('in_progress', [{ kind: 'onboarding', status: 'awaiting_cloudpc' }], fields).blocked).toMatch(/provisioning/);
    expect(editGuards('in_progress', [{ kind: 'onboarding', status: 'failed' }], fields).blocked).toBeNull();
  });

  it('blocks while an offboarding run is armed or running', () => {
    expect(editGuards('in_progress', [{ kind: 'offboarding', status: 'scheduled' }], fields).blocked).toMatch(/Cancel it/);
    expect(editGuards('in_progress', [{ kind: 'offboarding', status: 'running' }], fields).blocked).toMatch(/in progress/);
    expect(editGuards('in_progress', [{ kind: 'offboarding', status: 'cancelled' }], fields).blocked).toBeNull();
  });

  it('pins the UPN-defining name fields once the account exists (run succeeded, or create_user succeeded in a failed run)', () => {
    for (const runs of [[{ kind: 'onboarding', status: 'succeeded' }], [{ kind: 'onboarding', status: 'failed', account_created: true }]]) {
      const g = editGuards('in_progress', runs, [...fields, f('preferred_first_name')]);
      expect(Object.keys(g.locked).sort()).toEqual(['approvers', 'legal_first_name', 'legal_last_name', 'preferred_first_name']);
      expect(g.locked.legal_first_name).toMatch(/already been created/);
    }
    expect(editGuards('in_progress', [{ kind: 'onboarding', status: 'failed', account_created: false }], fields).locked).toEqual({ approvers: APPROVERS_LOCKED });
  });

  it('pins the departing user once an offboarding has run against them', () => {
    const off = [f('departing_user', { data_type: 'user', maps_to: 'affected' })];
    expect(editGuards('in_progress', [{ kind: 'offboarding', status: 'needs_review' }], off).locked.departing_user).toMatch(/already run/);
    expect(editGuards('in_progress', [], off).locked).toEqual({});
  });
});

describe('describeChange', () => {
  const users = new Map([[U2, { id: U2, name: 'Sam Super', email: 'sam@example.com' }]]);
  it('renders people by name, blanks, and hides PII', () => {
    expect(describeChange({ key: 'supervisor', label: 'Supervisor', data_type: 'user', sensitive: false, from: U1, to: U2 }, users))
      .toBe(`Supervisor: ${U1} → Sam Super <sam@example.com>`);
    expect(describeChange({ key: 'notes', label: 'Notes', data_type: 'textarea', sensitive: false, from: null, to: 'x' }, users))
      .toBe('Notes: (blank) → x');
    expect(describeChange({ key: 'personal_email', label: 'Personal email', data_type: 'email', sensitive: true, from: null, to: null }, users))
      .toBe('Personal email: changed');
  });
});

describe('formAnswersRefusal (legacy POST /tickets/:id/form-answers)', () => {
  const base = { ticketStatus: 'new', existingForm: null, formId: 'f1', formKey: 'new_user_access', catalogFormKey: null, runs: [] };
  it('only attaches a form to a ticket that has none', () => {
    expect(formAnswersRefusal(base)).toBeNull();
    expect(formAnswersRefusal({ ...base, existingForm: 'offboarding' })).toMatch(/PATCH/);
  });
  it('refuses a form other than the catalog item’s own', () => {
    expect(formAnswersRefusal({ ...base, catalogFormKey: 'offboarding' })).toMatch(/offboarding form/);
    expect(formAnswersRefusal({ ...base, catalogFormKey: 'new_user_access' })).toBeNull();
  });
  it('applies the same status and run guards as the edit path', () => {
    expect(formAnswersRefusal({ ...base, ticketStatus: 'closed' })).toMatch(/closed/);
    expect(formAnswersRefusal({ ...base, runs: [{ kind: 'offboarding', status: 'scheduled' }] })).toMatch(/offboarding/);
  });
});

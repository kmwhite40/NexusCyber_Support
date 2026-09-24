import { describe, it, expect, beforeEach, vi } from 'vitest';

// GET /tickets/:id/form reassembles a catalog submission for the staff fulfilling it. The shaping
// is pure (shapeSubmittedForm) and tested directly; getTicketForm is tested with the pool, the
// ticket read and the PII read mocked, to pin the access and audit rules:
//   - customer-plane callers are refused before anything is read;
//   - PII is fetched ONLY via readSensitive (which audits), ONLY with pii.view AND includePii.
const h = vi.hoisted(() => {
  let rows: (text: string, params: unknown[]) => any[] = () => [];
  const sql = { query: async (text: string, params: unknown[] = []) => ({ rows: rows(text, params) }) };
  return {
    sql,
    setRows: (fn: (text: string, params: unknown[]) => any[]) => { rows = fn; },
    withSystemContext: vi.fn(async (fn: any) => fn(sql)),
    getTicket: vi.fn(),
    readSensitive: vi.fn(),
  };
});

vi.mock('../src/db/pool.js', () => ({ withSystemContext: h.withSystemContext, withOrgContext: vi.fn(), pool: {} }));
vi.mock('../src/modules/tickets.js', () => ({ getTicket: h.getTicket }));
vi.mock('../src/modules/sensitive-fields.js', () => ({ readSensitive: h.readSensitive }));

const { shapeSubmittedForm, getTicketForm, toArray, OTHER_SECTION } = await import('../src/modules/ticket-form.js');
import type { FieldDef, ShapeInput } from '../src/modules/ticket-form.js';
import type { Principal } from '../src/types.js';

const U_REQ = '11111111-1111-1111-1111-111111111111';
const U_SUP = '22222222-2222-2222-2222-222222222222';
const U_APP = '33333333-3333-3333-3333-333333333333';
const ORG = '99999999-9999-9999-9999-999999999999';
const TICKET = '44444444-4444-4444-4444-444444444444';

const f = (key: string, over: Partial<FieldDef> = {}): FieldDef => ({
  key, label: key, data_type: 'text', maps_to: null, visible_when: null, sensitive: false, section: null, ...over,
});

const FIELDS: FieldDef[] = [
  f('on_behalf_of', { label: 'On behalf of', data_type: 'user', maps_to: 'requester', section: 'The request' }),
  f('start_date', { label: 'Start date', data_type: 'date', section: 'The request' }),
  f('legal_first_name', { label: 'First name', maps_to: 'subject', section: 'The person' }),
  f('personal_email', { label: 'Personal email', data_type: 'email', sensitive: true, section: 'The person' }),
  f('work_location', { label: 'Work location', data_type: 'select', section: 'Where they work' }),
  f('home_address_street', {
    label: 'Home address', sensitive: true, section: 'Where they work',
    visible_when: { field: 'work_location', equals: 'Work from Home - Permanent' },
  }),
  f('end_date', { label: 'End date', data_type: 'date', section: 'The role', visible_when: { field: 'access_type', equals: 'Temporary' } }),
  f('supervisor', { label: 'Supervisor', data_type: 'user', maps_to: 'manager', section: 'The role' }),
  f('employee_id', { label: 'Employee ID', section: 'The role' }),
  f('security_groups', { label: 'Groups', data_type: 'multiselect', section: 'Accounts and access' }),
  f('mfa_enrolled', { label: 'MFA', data_type: 'checkbox', section: 'Accounts and access' }),
  f('resume', { label: 'Resume', data_type: 'attachment', maps_to: 'attachment', section: 'Anything else' }),
  f('notes', { label: 'Notes', data_type: 'textarea', maps_to: 'description', section: 'Anything else' }),
  f('approvers', { label: 'Approvers', data_type: 'user_multi', maps_to: 'approvers', section: 'Anything else' }),
];

const users = new Map([
  [U_REQ, { id: U_REQ, name: 'Rita Requester', email: 'rita@example.com' }],
  [U_SUP, { id: U_SUP, name: 'Sam Super', email: 'sam@example.com' }],
  [U_APP, { id: U_APP, name: 'Ann Approver', email: 'ann@example.com' }],
]);

function input(over: Partial<ShapeInput> = {}): ShapeInput {
  return {
    formKey: 'user_onboarding',
    formName: 'User onboarding',
    fields: FIELDS,
    ticket: {
      status: 'in_progress',
      description: 'Needs a laptop by Monday',
      requester_id: U_REQ,
      affected_user_id: U_REQ,
      custom_fields: {
        _form: 'user_onboarding',
        start_date: '2026-10-01',
        legal_first_name: 'John',
        work_location: 'Work from Home - Permanent',
        supervisor: U_SUP,
        security_groups: 'VPN Users, Finance\nAll Staff',
        mfa_enrolled: true,
        cost_center: 'CC-100', // no longer on the form
      },
    },
    approvers: [{ approver_id: U_APP, name: 'Ann Approver', email: 'ann@example.com', status: 'pending' }],
    users,
    sensitiveKeys: ['personal_email', 'home_address_street'],
    sensitiveValues: null,
    ...over,
  };
}

const field = (out: ReturnType<typeof shapeSubmittedForm>, key: string) =>
  out.sections.flatMap((s) => s.fields).find((x) => x.key === key);

describe('shapeSubmittedForm', () => {
  it('groups fields by section in form order and puts removed-field answers last', () => {
    const out = shapeSubmittedForm(input());
    expect(out.sections.map((s) => s.section)).toEqual([
      'The request', 'The person', 'Where they work', 'The role', 'Accounts and access', 'Anything else', OTHER_SECTION,
    ]);
    expect(out.sections.at(-1)!.fields).toEqual([
      { key: 'cost_center', label: 'Cost center', data_type: 'text', sensitive: false, value: 'CC-100', display: 'CC-100' },
    ]);
    expect(field(out, '_form')).toBeUndefined();
  });

  it('puts back answers mapped onto ticket columns and approval steps', () => {
    const out = shapeSubmittedForm(input());
    expect(field(out, 'on_behalf_of')!.display).toBe('Rita Requester <rita@example.com>');
    expect(field(out, 'notes')!.display).toBe('Needs a laptop by Monday');
    expect(field(out, 'approvers')!.display).toEqual(['Ann Approver <ann@example.com>']);
    expect(out.notes).toBe('Needs a laptop by Monday');
    expect(out.requester).toEqual(users.get(U_REQ));
    expect(out.approvers).toEqual([{ name: 'Ann Approver', email: 'ann@example.com', status: 'pending' }]);
  });

  it('resolves user UUIDs, normalises legacy delimited groups, and renders booleans', () => {
    const out = shapeSubmittedForm(input());
    expect(field(out, 'supervisor')).toMatchObject({ value: U_SUP, display: 'Sam Super <sam@example.com>' });
    expect(field(out, 'security_groups')).toMatchObject({ value: ['VPN Users', 'Finance', 'All Staff'] });
    expect(field(out, 'mfa_enrolled')!.display).toBe('Yes');
  });

  it('shows unanswered visible fields as empty, but skips conditional fields that never applied and attachments', () => {
    const out = shapeSubmittedForm(input());
    expect(field(out, 'employee_id')).toMatchObject({ value: null, display: null });
    expect(field(out, 'end_date')).toBeUndefined(); // access_type was not Temporary
    expect(field(out, 'resume')).toBeUndefined();
  });

  it('withholds PII values when none were supplied, marking the fields sensitive', () => {
    const out = shapeSubmittedForm(input());
    expect(out.pii).toBe('withheld');
    expect(field(out, 'personal_email')).toMatchObject({ sensitive: true, value: null, display: null });
    expect(JSON.stringify(out)).not.toContain('@personal');
  });

  it('includes PII values when they were supplied', () => {
    const out = shapeSubmittedForm(input({ sensitiveValues: { personal_email: 'john@personal.example', home_address_street: '1 Main St' } }));
    expect(out.pii).toBe('included');
    expect(field(out, 'personal_email')).toMatchObject({ sensitive: true, value: 'john@personal.example' });
  });

  it('reports purged when a terminal ticket has no PII left, and none when the form has no PII', () => {
    const base = input();
    expect(shapeSubmittedForm({ ...base, sensitiveKeys: [], ticket: { ...base.ticket, status: 'closed' } }).pii).toBe('purged');
    expect(shapeSubmittedForm({ ...base, sensitiveKeys: [], fields: FIELDS.filter((x) => !x.sensitive) }).pii).toBe('none');
  });

  it('shows everything under Other answers when the form definition is gone', () => {
    const out = shapeSubmittedForm(input({ fields: [], formName: null }));
    expect(out.sections.map((s) => s.section)).toEqual([OTHER_SECTION]);
    expect(field(out, 'supervisor')!.display).toBe('Sam Super <sam@example.com>');
  });
});

describe('toArray', () => {
  it('splits legacy strings and filters blanks', () => {
    expect(toArray('a, b\n\nc')).toEqual(['a', 'b', 'c']);
    expect(toArray(['a', '', null])).toEqual(['a']);
    expect(toArray(null)).toEqual([]);
  });
});

describe('getTicketForm', () => {
  const nexus = (perms: string[]): Principal => ({
    id: 'agent', plane: 'nexus', email: 'a@x', displayName: null, organizationId: null,
    roles: [], permissions: perms, assignedOrgs: [ORG], allOrgs: false, elevated: false,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    h.withSystemContext.mockImplementation(async (fn: any) => fn(h.sql));
    h.getTicket.mockResolvedValue({
      id: TICKET, organization_id: ORG, status: 'in_progress', category: 'user.provisioning',
      description: null, requester_id: U_REQ, affected_user_id: U_REQ,
      custom_fields: { _form: 'user_onboarding', start_date: '2026-10-01' },
    });
    h.readSensitive.mockResolvedValue({ personal_email: 'john@personal.example' });
    h.setRows((text) => {
      if (/FROM request_forms/.test(text)) return [{ id: 'form-1', key: 'user_onboarding', name: 'User onboarding' }];
      if (/FROM form_fields/.test(text)) return FIELDS.map((x) => ({ ...x, options: [] }));
      if (/FROM approvals/.test(text)) return [];
      if (/FROM users/.test(text)) return [{ id: U_REQ, display_name: 'Rita Requester', email: 'rita@example.com' }];
      if (/FROM ticket_sensitive_fields/.test(text)) return [{ key: 'personal_email' }];
      return [];
    });
  });

  it('refuses customer-plane callers without reading the ticket', async () => {
    const cust = { ...nexus([]), plane: 'customer' as const, organizationId: ORG };
    await expect(getTicketForm(cust, TICKET)).rejects.toThrow(/staff/);
    expect(h.getTicket).not.toHaveBeenCalled();
  });

  it('goes through getTicket for the access check', async () => {
    h.getTicket.mockRejectedValue(new Error('ticket not found'));
    await expect(getTicketForm(nexus(['ticket.read.all_assigned_customers']), TICKET)).rejects.toThrow(/not found/);
  });

  it('withholds PII by default, even for a pii.view holder, and does not audit', async () => {
    const out = await getTicketForm(nexus(['pii.view']), TICKET);
    expect(out.pii).toBe('withheld');
    expect(h.readSensitive).not.toHaveBeenCalled();
    expect(out.form_name).toBe('User onboarding');
    expect(out.requester?.name).toBe('Rita Requester');
  });

  it('withholds PII when asked but the caller lacks pii.view', async () => {
    const out = await getTicketForm(nexus(['ticket.read.all_assigned_customers']), TICKET, { includePii: true });
    expect(out.pii).toBe('withheld');
    expect(h.readSensitive).not.toHaveBeenCalled();
  });

  it('reveals PII through the audited readSensitive when asked and permitted', async () => {
    const out = await getTicketForm(nexus(['pii.view']), TICKET, { includePii: true });
    expect(h.readSensitive).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent' }), TICKET);
    expect(out.pii).toBe('included');
    expect(field(out, 'personal_email')!.value).toBe('john@personal.example');
  });

  it('falls back to the catalog item form when custom_fields has no _form', async () => {
    h.getTicket.mockResolvedValue({
      id: TICKET, organization_id: ORG, status: 'new', category: 'user.provisioning',
      description: null, requester_id: null, affected_user_id: null, custom_fields: {},
    });
    const seen: unknown[][] = [];
    h.setRows((text, params) => {
      seen.push([text, params]);
      if (/FROM service_catalog_items/.test(text)) return [{ form_key: 'user_onboarding' }];
      if (/FROM request_forms/.test(text)) return [{ id: 'form-1', key: 'user_onboarding', name: 'User onboarding' }];
      return [];
    });
    const out = await getTicketForm(nexus([]), TICKET);
    expect(out.form_key).toBe('user_onboarding');
    expect(seen.some(([t, p]) => /service_catalog_items/.test(String(t)) && (p as unknown[])[0] === 'user.provisioning')).toBe(true);
  });
});

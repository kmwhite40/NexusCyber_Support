import { describe, it, expect } from 'vitest';
import { validateAgainstForm, type FormField } from '../src/modules/forms.js';

const fields: FormField[] = [
  { key: 'full_name', label: 'Full name', data_type: 'text', required: true, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null },
  { key: 'department', label: 'Department', data_type: 'select', required: true, options: ['Engineering', 'Sales'], maps_to: null, visible_when: null, sensitive: false, options_source: null },
  { key: 'start_date', label: 'Start date', data_type: 'date', required: true, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null },
  { key: 'seats', label: 'Seats', data_type: 'number', required: false, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null },
  { key: 'needs_admin', label: 'Admin', data_type: 'checkbox', required: false, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null },
];

describe('validateAgainstForm', () => {
  it('accepts a complete, well-typed submission', () => {
    const r = validateAgainstForm(fields, { full_name: 'Alex', department: 'Engineering', start_date: '2026-07-01', seats: 3, needs_admin: true });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('flags missing required fields', () => {
    const r = validateAgainstForm(fields, { department: 'Engineering', start_date: '2026-07-01' });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.field === 'full_name')).toBeTruthy();
  });

  it('rejects an out-of-range select value', () => {
    const r = validateAgainstForm(fields, { full_name: 'A', department: 'Marketing', start_date: '2026-07-01' });
    expect(r.errors.find((e) => e.field === 'department')?.message).toMatch(/one of/i);
  });

  it('rejects a malformed date and non-numeric number', () => {
    const r = validateAgainstForm(fields, { full_name: 'A', department: 'Sales', start_date: 'July 1', seats: 'lots' });
    expect(r.errors.find((e) => e.field === 'start_date')).toBeTruthy();
    expect(r.errors.find((e) => e.field === 'seats')).toBeTruthy();
  });

  it('accepts numeric strings for number fields', () => {
    const r = validateAgainstForm(fields, { full_name: 'A', department: 'Sales', start_date: '2026-07-01', seats: '5' });
    expect(r.ok).toBe(true);
  });
});

const F = (over: Partial<FormField>): FormField => ({
  key: 'k', label: 'K', data_type: 'text', required: false, options: [], maps_to: null,
  visible_when: null, sensitive: false, options_source: null, ...over,
});

describe('validateAgainstForm — people + attachment types', () => {
  it('accepts a user id string for a required user field', () => {
    const r = validateAgainstForm([F({ key: 'u', label: 'User', data_type: 'user', required: true })], { u: 'usr-1' });
    expect(r.ok).toBe(true);
  });

  it('flags a missing required user field', () => {
    const r = validateAgainstForm([F({ key: 'u', label: 'User', data_type: 'user', required: true })], {});
    expect(r.ok).toBe(false);
    expect(r.errors[0].field).toBe('u');
  });

  it('treats an empty array as missing for a required user_multi field', () => {
    const r = validateAgainstForm([F({ key: 'a', label: 'Approvers', data_type: 'user_multi', required: true })], { a: [] });
    expect(r.ok).toBe(false);
  });

  it('accepts an array of ids for user_multi', () => {
    const r = validateAgainstForm([F({ key: 'a', label: 'Approvers', data_type: 'user_multi', required: true })], { a: ['x', 'y'] });
    expect(r.ok).toBe(true);
  });

  it('does not validate attachment fields (handled out of band)', () => {
    const r = validateAgainstForm([F({ key: 'f', label: 'File', data_type: 'attachment', required: true })], {});
    expect(r.ok).toBe(true);
  });
});

const base = { required: true, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null };

describe('email and phone field types', () => {
  it('rejects a malformed email and accepts a valid one', () => {
    const fields = [{ key: 'personal_email', label: 'Personal email', data_type: 'email' as const, ...base }];
    expect(validateAgainstForm(fields, { personal_email: 'nope' }).ok).toBe(false);
    expect(validateAgainstForm(fields, { personal_email: 'a@b.gov' }).ok).toBe(true);
  });

  it('accepts common phone formats and rejects letters', () => {
    const fields = [{ key: 'cell_phone', label: 'Cell', data_type: 'phone' as const, ...base }];
    expect(validateAgainstForm(fields, { cell_phone: '(555) 123-4567' }).ok).toBe(true);
    expect(validateAgainstForm(fields, { cell_phone: 'call me' }).ok).toBe(false);
  });
});

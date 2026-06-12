import { describe, it, expect } from 'vitest';
import { validateAgainstForm, type FormField } from '../src/modules/forms.js';

const fields: FormField[] = [
  { key: 'full_name', label: 'Full name', data_type: 'text', required: true, options: [] },
  { key: 'department', label: 'Department', data_type: 'select', required: true, options: ['Engineering', 'Sales'] },
  { key: 'start_date', label: 'Start date', data_type: 'date', required: true, options: [] },
  { key: 'seats', label: 'Seats', data_type: 'number', required: false, options: [] },
  { key: 'needs_admin', label: 'Admin', data_type: 'checkbox', required: false, options: [] },
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

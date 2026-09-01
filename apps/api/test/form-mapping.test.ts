import { describe, it, expect } from 'vitest';
import { mapFormAnswers, customFieldsFor, type FormField } from '../src/modules/forms.js';
import { splitSensitiveAnswers } from '../src/modules/sensitive-fields.js';

const F = (over: Partial<FormField>): FormField => ({
  key: 'k', label: 'K', data_type: 'text', required: false, options: [], maps_to: null,
  visible_when: null, sensitive: false, options_source: null, ...over,
});

const FIELDS: FormField[] = [
  F({ key: 'on_behalf_of', data_type: 'user', maps_to: 'requester' }),
  F({ key: 'summary', data_type: 'text', maps_to: 'subject' }),
  F({ key: 'system', data_type: 'select', maps_to: null }),
  F({ key: 'reason', data_type: 'textarea', maps_to: 'description' }),
  F({ key: 'manager', data_type: 'user', maps_to: 'manager' }),
  F({ key: 'approvers', data_type: 'user_multi', maps_to: 'approvers' }),
  F({ key: 'attachment', data_type: 'attachment', maps_to: 'attachment' }),
];

describe('mapFormAnswers', () => {
  it('routes mapped fields to ticket columns / approvals / custom_fields', () => {
    const m = mapFormAnswers(FIELDS, {
      on_behalf_of: 'usr-cust', summary: 'Need Jira', system: 'Jira',
      reason: 'new hire', manager: 'usr-mgr', approvers: ['usr-a', 'usr-b'], attachment: 'ignored',
    });
    expect(m.subject).toBe('Need Jira');
    expect(m.description).toBe('new hire');
    expect(m.requesterId).toBe('usr-cust');
    expect(m.affectedUserId).toBe('usr-cust');
    expect(m.approverIds).toEqual(['usr-a', 'usr-b']);
    expect(m.customFields).toMatchObject({ system: 'Jira', manager: 'usr-mgr' });
    expect(m.customFields).not.toHaveProperty('attachment');
  });

  it('falls back to defaultRequesterId when on-behalf-of is empty', () => {
    const m = mapFormAnswers(FIELDS, { summary: 'x' }, { defaultRequesterId: 'self-1' });
    expect(m.requesterId).toBe('self-1');
    expect(m.affectedUserId).toBe('self-1');
  });

  it("routes an 'affected' field to affected-user only; requester falls back to the submitter", () => {
    const offboarding: FormField[] = [
      F({ key: 'departing_user', data_type: 'user', maps_to: 'affected' }),
      F({ key: 'summary', data_type: 'text', maps_to: 'subject' }),
    ];
    const m = mapFormAnswers(offboarding, { departing_user: 'usr-leaving', summary: 'Offboard Jo' }, { defaultRequesterId: 'mgr-1' });
    expect(m.affectedUserId).toBe('usr-leaving'); // the departing person
    expect(m.requesterId).toBe('mgr-1'); // the manager raising it (submitter)
    expect(m.customFields).toMatchObject({ departing_user: 'usr-leaving' });
  });
});

describe('custom_fields never receives a sensitive answer', () => {
  it('splitSensitiveAnswers keeps sensitive keys out of the normal bag', () => {
    const fields = [
      { key: 'job_title', label: 'Job title', data_type: 'text' as const, required: false, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null },
      { key: 'personal_email', label: 'Personal email', data_type: 'email' as const, required: false, options: [], maps_to: null, visible_when: null, sensitive: true, options_source: null },
    ];
    const { normal } = splitSensitiveAnswers(fields, { job_title: 'Analyst', personal_email: 'a@b.com' });
    expect(Object.keys(normal)).not.toContain('personal_email');
  });

  // submitAnswers itself calls customFieldsFor to decide what merges into
  // tickets.custom_fields; this exercises that exact routing decision (not just the
  // lower-level split helper) without needing a database.
  it('customFieldsFor (used by submitAnswers) excludes sensitive answers from custom_fields and routes them to `sensitive`', () => {
    const fields: FormField[] = [
      F({ key: 'job_title', data_type: 'text', sensitive: false }),
      F({ key: 'ssn', data_type: 'text', sensitive: true }),
    ];
    const { customFields, sensitive } = customFieldsFor(
      fields,
      { job_title: 'Analyst', ssn: '123-45-6789' },
      'form-onboarding',
    );
    expect(customFields).toMatchObject({ job_title: 'Analyst', _form: 'form-onboarding' });
    expect(customFields).not.toHaveProperty('ssn');
    expect(sensitive).toEqual({ ssn: '123-45-6789' });
  });
});

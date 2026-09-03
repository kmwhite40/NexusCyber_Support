import { describe, it, expect } from 'vitest';
import { planRequestWrite } from '../src/modules/catalog.js';
import type { FormField } from '../src/modules/forms.js';

// The SBS onboarding fields as migrations 0054 + 0055 actually seed them — same keys, same
// `sensitive` flags, same `visible_when` option strings (character-for-character; an
// abbreviated string here would pass while masking the silent-hide failure mode).
const F = (over: Partial<FormField>): FormField => ({
  key: 'k', label: 'K', data_type: 'text', required: false, options: [], maps_to: null,
  visible_when: null, sensitive: false, options_source: null, ...over,
});

const WFH = ['Work from Home - Permanent', 'Work from Home - Temporary'];

const ONBOARDING: FormField[] = [
  F({ key: 'on_behalf_of', data_type: 'user', maps_to: 'requester' }),
  F({ key: 'legal_first_name', required: true, maps_to: 'subject' }),
  F({ key: 'legal_last_name', required: true, maps_to: 'subject' }),
  F({ key: 'job_title' }),
  F({ key: 'request_kind', data_type: 'select', required: true, options: ['New Hire', 'Replacement'] }),
  F({ key: 'replacement_for', data_type: 'user', visible_when: { field: 'request_kind', equals: 'Replacement' } }),
  F({ key: 'supervisor', data_type: 'user', required: true, maps_to: 'manager' }),
  F({ key: 'work_location', data_type: 'select', required: true, options: [...WFH, 'On Site'] }),
  F({ key: 'personal_email', data_type: 'email', sensitive: true }),
  F({ key: 'cell_phone', data_type: 'phone', sensitive: true }),
  F({ key: 'home_address_street', sensitive: true, visible_when: { field: 'work_location', in: WFH } }),
  F({ key: 'home_address_csz', sensitive: true, visible_when: { field: 'work_location', in: WFH } }),
];

const SENSITIVE_KEYS = ['personal_email', 'cell_phone', 'home_address_street', 'home_address_csz'];

// planRequestWrite is exactly what createRequest persists: `.customFields` is the object it
// stringifies into tickets.custom_fields, `.sensitive` is the bag it hands to
// storeSensitiveWith -> ticket_sensitive_fields. Asserting on it asserts on the shipped
// behaviour of the primary intake path (POST /catalog/:key/request) without a database.
describe('createRequest (planRequestWrite): PII never reaches tickets.custom_fields', () => {
  const wfhAnswers = {
    on_behalf_of: 'usr-new',
    legal_first_name: 'John', legal_last_name: 'Doe', job_title: 'Analyst',
    request_kind: 'New Hire', supervisor: 'usr-mgr',
    work_location: 'Work from Home - Permanent',
    personal_email: 'john.doe@example.com',
    cell_phone: '(555) 123-4567',
    home_address_street: '1 Main St',
    home_address_csz: 'Springfield, VA 22150',
  };

  it('keeps every sensitive answer out of custom_fields and routes it to the sensitive store', () => {
    const w = planRequestWrite(ONBOARDING, wfhAnswers, 'user_onboarding');
    for (const key of SENSITIVE_KEYS) expect(w.customFields).not.toHaveProperty(key);
    expect(w.sensitive).toEqual({
      personal_email: 'john.doe@example.com',
      cell_phone: '(555) 123-4567',
      home_address_street: '1 Main St',
      home_address_csz: 'Springfield, VA 22150',
    });
  });

  it('no PII value appears anywhere in the serialized custom_fields blob', () => {
    const w = planRequestWrite(ONBOARDING, wfhAnswers, 'user_onboarding');
    const blob = JSON.stringify(w.customFields);
    for (const value of Object.values(w.sensitive)) expect(blob).not.toContain(String(value));
  });

  it('still records the non-sensitive answers and the form key', () => {
    const w = planRequestWrite(ONBOARDING, wfhAnswers, 'user_onboarding');
    expect(w.customFields).toMatchObject({
      job_title: 'Analyst', request_kind: 'New Hire',
      work_location: 'Work from Home - Permanent', supervisor: 'usr-mgr',
      // Subject-mapped too, but still recorded: Phase 2's deriveUpn reads them from here.
      legal_first_name: 'John', legal_last_name: 'Doe',
      _form: 'user_onboarding',
    });
  });

  it('sensitive answers never reach a ticket column either (subject/description)', () => {
    const fields = [F({ key: 'ssn', sensitive: true, maps_to: 'subject' })];
    const w = planRequestWrite(fields, { ssn: '123-45-6789' }, 'f');
    expect(w.mapped.subject).toBeUndefined();
    expect(w.customFields).not.toHaveProperty('ssn');
    expect(w.sensitive).toEqual({ ssn: '123-45-6789' });
  });
});

describe('createRequest (planRequestWrite): hidden fields are never persisted', () => {
  it('drops a sensitive hidden answer — the direct-API-client attack (On Site + home address)', () => {
    // validateAgainstForm skips hidden fields, so this value is never validated; it must
    // therefore never be stored, in custom_fields OR in the sensitive store.
    const w = planRequestWrite(
      ONBOARDING,
      { ...wfh(), work_location: 'On Site', home_address_street: '1 Main St', home_address_csz: 'Springfield, VA 22150' },
      'user_onboarding',
    );
    expect(w.customFields).not.toHaveProperty('home_address_street');
    expect(w.customFields).not.toHaveProperty('home_address_csz');
    expect(w.sensitive).not.toHaveProperty('home_address_street');
    expect(w.sensitive).not.toHaveProperty('home_address_csz');
  });

  it('drops a non-sensitive hidden answer (replacement_for on a New Hire)', () => {
    const w = planRequestWrite(
      ONBOARDING,
      { ...wfh(), request_kind: 'New Hire', replacement_for: 'usr-someone' },
      'user_onboarding',
    );
    expect(w.customFields).not.toHaveProperty('replacement_for');
  });

  it('persists the same field once its condition IS met', () => {
    const w = planRequestWrite(
      ONBOARDING,
      { ...wfh(), request_kind: 'Replacement', replacement_for: 'usr-someone' },
      'user_onboarding',
    );
    expect(w.customFields).toMatchObject({ replacement_for: 'usr-someone' });
  });

  it('drops an answer for a key the form does not declare', () => {
    const w = planRequestWrite(ONBOARDING, { ...wfh(), injected: 'x' }, 'user_onboarding');
    expect(w.customFields).not.toHaveProperty('injected');
  });

  function wfh() {
    return {
      legal_first_name: 'John', legal_last_name: 'Doe',
      request_kind: 'New Hire', supervisor: 'usr-mgr', work_location: 'On Site',
    };
  }
});

describe('createRequest: onboarding ticket subject is a full name', () => {
  it('composes first + last name in field order', () => {
    const w = planRequestWrite(ONBOARDING, {
      legal_first_name: 'John', legal_last_name: 'Doe',
      request_kind: 'New Hire', supervisor: 'usr-mgr', work_location: 'On Site',
    }, 'user_onboarding');
    expect(w.mapped.subject).toBe('John Doe');
  });

  it('a single subject field still maps to just that value', () => {
    const w = planRequestWrite([F({ key: 'summary', maps_to: 'subject' })], { summary: 'Need Jira' }, 'f');
    expect(w.mapped.subject).toBe('Need Jira');
  });
});

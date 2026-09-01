import { describe, it, expect } from 'vitest';
import { splitSensitiveAnswers } from '../src/modules/sensitive-fields.js';
import type { FormField } from '../src/modules/forms.js';

const f = (key: string, sensitive: boolean): FormField => ({
  key, label: key, data_type: 'text', required: false, options: [],
  maps_to: null, visible_when: null, sensitive, options_source: null,
});

describe('splitSensitiveAnswers', () => {
  it('routes sensitive answers away from the normal bag', () => {
    const fields = [f('job_title', false), f('cell_phone', true)];
    const out = splitSensitiveAnswers(fields, { job_title: 'Analyst', cell_phone: '555-0100' });
    expect(out.normal).toEqual({ job_title: 'Analyst' });
    expect(out.sensitive).toEqual({ cell_phone: '555-0100' });
  });

  it('ignores answers for fields the form does not declare', () => {
    const out = splitSensitiveAnswers([f('job_title', false)], { job_title: 'A', injected: 'x' });
    expect(out.normal).toEqual({ job_title: 'A' });
    expect(out.sensitive).toEqual({});
  });

  // Option strings as migration 0054 seeds them, character-for-character.
  it('drops sensitive answers whose field is not visible', () => {
    const hidden: FormField = { ...f('home_address_street', true),
      visible_when: { field: 'work_location', in: ['Work from Home - Permanent', 'Work from Home - Temporary'] } };
    const out = splitSensitiveAnswers([hidden], { work_location: 'On Site', home_address_street: '1 Main St' });
    expect(out.sensitive).toEqual({});
    const shown = splitSensitiveAnswers([hidden], { work_location: 'Work from Home - Permanent', home_address_street: '1 Main St' });
    expect(shown.sensitive).toEqual({ home_address_street: '1 Main St' });
  });
});

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DynamicFormField } from '@/components/dynamic-form-field';
import type { FormFieldDef } from '@/lib/api';

const field = (over: Partial<FormFieldDef>): FormFieldDef => ({
  key: 'cloud_pc_policy', label: 'Cloud PC provisioning policy', data_type: 'select',
  required: false, options: [], visible_when: null, sensitive: false,
  options_source: 'cloudpc_policies', section: null, ...over,
} as FormFieldDef);

// Cloud PC is optional in the data (required=false) but was mandatory in practice: the empty
// placeholder option was `disabled`, so once a policy had been chosen there was no way back to
// blank. An optional field you cannot clear is a required one — and here it decides whether the
// hire consumes one of two remaining Windows 365 licences.
describe('optional select fields', () => {
  const common = {
    value: 'SBSFederal Cloud PC', answers: {}, options: ['SBSFederal Cloud PC'],
    onChange: vi.fn(), renderUserPicker: () => null,
  };

  it('offers a selectable empty choice when the field is optional', async () => {
    const onChange = vi.fn();
    render(<DynamicFormField {...common} onChange={onChange} field={field({})} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const blank = Array.from(select.options).find((o) => o.value === '')!;
    expect(blank).toBeTruthy();
    expect(blank.disabled).toBe(false);
    await userEvent.selectOptions(select, '');
    expect(onChange).toHaveBeenCalledWith('cloud_pc_policy', '');
  });

  // A required select keeps the un-choosable prompt, so "Select…" cannot be submitted as an answer.
  it('keeps the placeholder unselectable when the field is required', () => {
    render(<DynamicFormField {...common} field={field({ required: true })} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(Array.from(select.options).find((o) => o.value === '')!.disabled).toBe(true);
  });

  it('labels the empty choice as meaning none, not as a prompt', () => {
    render(<DynamicFormField {...common} field={field({})} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(Array.from(select.options).find((o) => o.value === '')!.textContent).toMatch(/none/i);
  });
});

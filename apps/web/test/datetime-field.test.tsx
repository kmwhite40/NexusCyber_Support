import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DynamicFormField, localInputToIsoInstant } from '@/components/dynamic-form-field';

// A `datetime` field must submit an INSTANT the API will accept. The API validator requires a
// zone designator, and <input type="datetime-local"> yields a bare local wall-clock string with
// none — so submitting the raw input value would be rejected every time, on a field whose whole
// purpose is scheduling a termination.
describe('localInputToIsoInstant', () => {
  it('turns a datetime-local value into an instant carrying an offset', () => {
    const out = localInputToIsoInstant('2026-09-05T17:00');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
  });

  it('round-trips to the same moment the operator picked', () => {
    const out = localInputToIsoInstant('2026-09-05T17:00');
    expect(new Date(out).getTime()).toBe(new Date('2026-09-05T17:00').getTime());
  });

  it('passes an empty value through rather than inventing a time', () => {
    expect(localInputToIsoInstant('')).toBe('');
  });
});

describe('DynamicFormField — datetime', () => {
  const field = {
    key: 'disable_effective', label: 'Disable effective', data_type: 'datetime' as const,
    required: true, options: [], maps_to: null, visible_when: null, sensitive: false, options_source: null,
  };

  // Queried by element rather than by label: the shared Field primitive does not wire
  // htmlFor/id, so getByLabelText finds no associated control for ANY field in this app. That
  // is a real accessibility gap, but a pre-existing one and not this field's to fix.
  it('renders a datetime-local picker, not a bare text box', () => {
    const { container } = render(
      <DynamicFormField field={field} value="" answers={{}} options={[]} onChange={vi.fn()} renderUserPicker={() => null} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
  });

  it('reports an instant with an offset, not the raw local string', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <DynamicFormField field={field} value="" answers={{}} options={[]} onChange={onChange} renderUserPicker={() => null} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    await userEvent.type(input, '2026-09-05T17:00');
    const last = onChange.mock.calls.at(-1)?.[1];
    expect(String(last)).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
  });
});

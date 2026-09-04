import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field, Input, Select, Textarea } from '@/components/ui/primitives';

// A design review counted 23 <label> tags in the app with exactly ONE htmlFor, and 74 inputs with
// zero ids. Field wraps nearly every text/select/textarea in the product — catalog forms, the
// integrations page, admin dialogs — so a screen reader announced "edit text, blank" for almost
// every control in a federal platform. Fixing the wrapper fixes the app.
describe('Field associates its label with its control', () => {
  it('gives an Input an accessible name from the Field label', () => {
    render(<Field label="Directory (tenant) ID"><Input /></Field>);
    expect(screen.getByLabelText('Directory (tenant) ID')).toBeTruthy();
  });

  it('works for Select and Textarea too', () => {
    render(
      <>
        <Field label="Customer"><Select><option>a</option></Select></Field>
        <Field label="Details"><Textarea /></Field>
      </>,
    );
    expect(screen.getByLabelText('Customer').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Details').tagName).toBe('TEXTAREA');
  });

  // Clicking a label should focus its control. That only works through a real association, which
  // is also what makes the hit target the size of the label rather than the box alone.
  it('points the label at the control by id', () => {
    const { container } = render(<Field label="Client secret"><Input /></Field>);
    const label = container.querySelector('label')!;
    const input = container.querySelector('input')!;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(input.id).toBeTruthy();
  });

  // The hint is the only place some fields explain themselves ("Write-only. Stored encrypted and
  // never shown again."). Unassociated, a screen-reader user never hears it.
  it('exposes the hint as the control description', () => {
    render(<Field label="Client secret" hint="Write-only. Never shown again."><Input /></Field>);
    expect(screen.getByLabelText('Client secret')).toHaveAccessibleDescription('Write-only. Never shown again.');
  });

  // Inside a Field the field's own id wins, so label and control can never disagree. Letting a
  // caller's id through would quietly break the association the label depends on — the exact
  // failure this change exists to remove. Nothing in the app sets one inside a Field today.
  it('keeps label and control agreeing even if a caller passes an id', () => {
    const { container } = render(<Field label="Subject"><Input id="explicit-id" /></Field>);
    const label = container.querySelector('label')!;
    const input = container.querySelector('input')!;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(screen.getByLabelText('Subject')).toBe(input);
  });

  it('leaves a control outside any Field alone', () => {
    const { container } = render(<Input aria-label="standalone" />);
    expect(container.querySelector('input')!.id).toBe('');
  });
});

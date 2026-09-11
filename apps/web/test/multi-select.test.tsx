import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiSelect } from '@/components/multi-select';

// "Security / distribution groups" was a free-text box. Requesters typed names from memory, so a
// mistyped one became a group_missing blocker after approval — and far more often the box was
// left blank and the hire was provisioned into no groups at all. It is now a list of the tenant's
// real groups, chosen rather than typed.
describe('MultiSelect', () => {
  const options = ['All Staff', 'Engineering', 'Finance'];

  it('adds a value when its option is chosen', async () => {
    const onChange = vi.fn();
    render(<MultiSelect options={options} value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Engineering'));
    expect(onChange).toHaveBeenCalledWith(['Engineering']);
  });

  it('removes a value when its option is unchosen', async () => {
    const onChange = vi.fn();
    render(<MultiSelect options={options} value={['All Staff', 'Engineering']} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('All Staff'));
    expect(onChange).toHaveBeenCalledWith(['Engineering']);
  });

  it('filters the list without losing what is already chosen', async () => {
    render(<MultiSelect options={options} value={['All Staff']} onChange={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/filter/i), 'fin');
    expect(screen.queryByLabelText('Engineering')).toBeNull();
    expect(screen.getByLabelText('Finance')).toBeTruthy();
    // The chosen value is still visible as a chip even though the filter excludes it.
    expect(screen.getByText('All Staff')).toBeTruthy();
  });

  // A picker that renders nothing looks identical to one whose list is still loading, which is
  // the confusion the people picker had to be fixed for twice. Say which it is.
  it('says the list is empty rather than rendering nothing', () => {
    render(<MultiSelect options={[]} value={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no groups|nothing to choose|unavailable/i)).toBeTruthy();
  });

  it('says so when the filter matches none of the options', async () => {
    render(<MultiSelect options={options} value={[]} onChange={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/filter/i), 'zzz');
    expect(screen.getByText(/no match/i)).toBeTruthy();
  });

  // A list that stopped at the page ceiling but presents itself as the whole tenant is worse than
  // no list: the requester concludes a group does not exist, and the thing meant to stop them
  // mistyping a name becomes the thing that tells them the right name is wrong.
  it('warns when the list it was given is incomplete', () => {
    render(<MultiSelect options={options} value={[]} onChange={vi.fn()} truncated />);
    expect(screen.getByText(/not the complete list|incomplete|more groups/i)).toBeTruthy();
  });

  // Values chosen before the live list arrived (or that have since been deleted from the tenant)
  // must stay selected and stay visible — dropping them silently would quietly narrow a request
  // someone already filled in.
  it('keeps a chosen value that is not in the options list', () => {
    render(<MultiSelect options={options} value={['Retired Group']} onChange={vi.fn()} />);
    expect(screen.getByText('Retired Group')).toBeTruthy();
  });
});

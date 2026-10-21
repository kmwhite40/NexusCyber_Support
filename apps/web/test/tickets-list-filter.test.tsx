// The /tickets list (also customers' "My requests"). Closed tickets live in Archived, so
// the list asks the API to leave them out unless "Include closed" is ticked; picking a
// status from the dropdown asks for exactly that status, closed included.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TicketsPage from '@/app/(app)/tickets/page';
import { api } from '@/lib/api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
const mockedApi = vi.mocked(api, true);

/** The query string of the most recent /tickets request. */
function lastTicketsQuery(): URLSearchParams {
  const urls = mockedApi.get.mock.calls.map(([u]) => u as string).filter((u) => u.startsWith('/tickets?'));
  expect(urls.length).toBeGreaterThan(0);
  return new URLSearchParams(urls[urls.length - 1].slice('/tickets?'.length));
}

describe('TicketsPage closed filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockResolvedValue({ data: [] });
  });

  it('excludes closed tickets by default', async () => {
    render(<TicketsPage />);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalled());

    const qs = lastTicketsQuery();
    expect(qs.get('exclude_status')).toBe('closed');
    expect(qs.get('status')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /include closed/i })).not.toBeChecked();
  });

  it('includes closed tickets once the toggle is ticked', async () => {
    render(<TicketsPage />);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('checkbox', { name: /include closed/i }));
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(2));

    const qs = lastTicketsQuery();
    expect(qs.get('exclude_status')).toBeNull();
    expect(qs.get('status')).toBeNull();
  });

  it('asks for exactly the chosen status, closed included', async () => {
    render(<TicketsPage />);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(screen.getByRole('combobox'), 'closed');
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(2));

    const qs = lastTicketsQuery();
    expect(qs.get('status')).toBe('closed');
    expect(qs.get('exclude_status')).toBeNull();
  });

  it('offers every workflow status in the dropdown', () => {
    render(<TicketsPage />);
    const values = Array.from(screen.getByRole('combobox').querySelectorAll('option')).map((o) => o.getAttribute('value'));
    for (const s of ['new', 'triage', 'assigned', 'in_progress', 'blocked', 'waiting_customer', 'waiting_vendor',
      'on_hold', 'resolved', 'reopened', 'closed']) {
      expect(values).toContain(s);
    }
  });
});

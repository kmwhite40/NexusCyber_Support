// The /queues page. A queue with no status filter would otherwise list every closed ticket
// it ever matched; the API hides them unless the page asks with include_closed=true.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueuesPage from '@/app/(app)/queues/page';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
const mockedApi = vi.mocked(api, true);

const QUEUE = { id: 'q-1', name: 'P1 incidents', order_by: 'sla', definition: { priority: 'P1' } };

function queueTicketUrls(): string[] {
  return mockedApi.get.mock.calls.map(([u]) => u as string).filter((u) => u.startsWith('/queues/q-1/tickets'));
}

describe('QueuesPage closed toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockImplementation((url: string) => {
      if (url === '/queues') return Promise.resolve({ data: [QUEUE] });
      return Promise.resolve({ queue: QUEUE, tickets: [] });
    });
  });

  it('leaves closed out by default and asks for it once the toggle is ticked', async () => {
    render(<QueuesPage />);
    await waitFor(() => expect(queueTicketUrls()).toHaveLength(1));
    expect(queueTicketUrls()[0]).not.toMatch(/include_closed=true/);

    const toggle = screen.getByRole('checkbox', { name: /include closed/i });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => expect(queueTicketUrls()).toHaveLength(2));
    expect(queueTicketUrls()[1]).toMatch(/include_closed=true/);
  });
});

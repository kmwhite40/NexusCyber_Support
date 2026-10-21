// The /problems page: creating a problem.
//
// Staff have no organization of their own, so a problem created from the nexus plane must
// name the customer it belongs to — without one the API answers 400 "organizationId
// required". create() used to have no error handling at all, so that 400 vanished and the
// Create button simply did nothing.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProblemsPage from '@/app/(app)/problems/page';
import { api, ApiError, type Me } from '@/lib/api';

const authState = { me: null as Me | null, can: (_p: string) => false };

vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({ ...authState, loading: false, refresh: vi.fn(), logout: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() };
  return { ...actual, api: mock };
});
const mockedApi = vi.mocked(api, true);

const ORG = '88888888-8888-8888-8888-888888888888';

function asUser(over: Partial<Me>, caps: string[]) {
  authState.me = {
    id: 'u1', plane: 'customer', email: 'admin@acme.gov', organization_id: ORG,
    roles: [], capabilities: caps, ...over,
  } as Me;
  authState.can = (p: string) => caps.includes(p);
}

describe('ProblemsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.me = null;
    authState.can = () => false;
    mockedApi.get.mockImplementation((url: string) => {
      if (url.startsWith('/organizations')) return Promise.resolve({ data: [{ id: ORG, name: 'Acme Federal' }] });
      if (url === '/problems/p-new') {
        return Promise.resolve({
          id: 'p-new', title: 'Recurring VPN drops', status: 'open', priority: 'P3', known_error: false,
          incident_count: 0, root_cause: null, workaround: null, description: null, incidents: [],
        });
      }
      return Promise.resolve({ data: [] });
    });
  });

  it('makes a nexus user pick the customer organization and sends it on create', async () => {
    mockedApi.post.mockResolvedValue({ id: 'p-new' });
    asUser({ plane: 'nexus', organization_id: null }, ['problem.manage']);
    render(<ProblemsPage />);

    const org = await screen.findByLabelText('Customer organization');
    await screen.findByRole('option', { name: 'Acme Federal' });
    await userEvent.type(screen.getByPlaceholderText(/new problem title/i), 'Recurring VPN drops');
    await userEvent.selectOptions(org, ORG);
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith('/problems', { title: 'Recurring VPN drops', organizationId: ORG }),
    );
  });

  it('does not offer the organization picker to a customer user', async () => {
    asUser({}, ['problem.manage']);
    render(<ProblemsPage />);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalled());
    expect(screen.queryByLabelText('Customer organization')).not.toBeInTheDocument();
    expect(mockedApi.get.mock.calls.map(([u]) => u as string)).not.toContain('/organizations');
  });

  it('shows why the API refused a create instead of silently doing nothing', async () => {
    mockedApi.post.mockRejectedValue(new ApiError(400, 'organizationId required'));
    asUser({}, ['problem.manage']);
    render(<ProblemsPage />);

    await userEvent.type(screen.getByPlaceholderText(/new problem title/i), 'Recurring VPN drops');
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText('organizationId required')).toBeInTheDocument();
    // The title survives the failure so it can be retried.
    expect(screen.getByPlaceholderText(/new problem title/i)).toHaveValue('Recurring VPN drops');
  });

  it('does not post a title shorter than the API accepts', async () => {
    asUser({}, ['problem.manage']);
    render(<ProblemsPage />);

    await userEvent.type(screen.getByPlaceholderText(/new problem title/i), 'ab');
    const create = screen.getByRole('button', { name: /^create$/i });
    expect(create).toBeDisabled();
    await userEvent.click(create);
    expect(mockedApi.post).not.toHaveBeenCalled();
  });
});

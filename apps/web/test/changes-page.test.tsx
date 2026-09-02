// The /changes page container: list | calendar | CAB settings.
//
// Guards the tab gating (CAB settings is a cab.manage screen) and the org the settings
// tab is handed — a customer admin must arrive with their own organization already
// resolved, because a settings screen that reaches the API with no organizationId is
// asking for the GLOBAL config and gets a 403.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChangesPage from '@/app/(app)/changes/page';
import { api, type Me } from '@/lib/api';

const authState = { me: null as Me | null, can: (_p: string) => false };

vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({ ...authState, loading: false, refresh: vi.fn(), logout: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() };
  return {
    ...actual,
    api: mock,
    users: { search: () => mock.get('/users/search') },
    platformUsersApi: { ...actual.platformUsersApi, list: () => mock.get('/platform/users') },
  };
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

describe('ChangesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.me = null;
    authState.can = () => false;
    mockedApi.get.mockImplementation((url: string) => {
      if (url.startsWith('/organizations')) return Promise.resolve({ data: [{ id: ORG, name: 'Acme Federal' }] });
      if (url.startsWith('/cab/board')) {
        return Promise.resolve({ data: { organization_id: ORG, name: 'Change Advisory Board', quorum: 1, threshold: 'majority', members: [] } });
      }
      return Promise.resolve({ data: [] });
    });
  });

  it('offers only list and calendar without cab.manage', async () => {
    asUser({}, ['change.create']);
    render(<ChangesPage />);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalled());

    expect(screen.getByRole('tab', { name: 'List' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /cab settings/i })).not.toBeInTheDocument();
  });

  it('opens CAB settings on the admin’s own organization, never on global', async () => {
    asUser({}, ['cab.manage']);
    render(<ChangesPage />);
    await userEvent.click(screen.getByRole('tab', { name: /cab settings/i }));

    // A customer admin has exactly one org, so no picker and no unscoped call.
    await waitFor(() => {
      const board = mockedApi.get.mock.calls.map(([u]) => u as string).find((u) => u.startsWith('/cab/board'));
      expect(board).toBe(`/cab/board?organizationId=${ORG}`);
    });
  });

  it('makes a nexus admin choose an organization before touching CAB config', async () => {
    asUser({ plane: 'nexus', organization_id: null }, ['cab.manage']);
    render(<ChangesPage />);
    await userEvent.click(screen.getByRole('tab', { name: /cab settings/i }));

    expect(await screen.findByLabelText('Organization')).toBeInTheDocument();
    // Nothing was read with an implicit (global) scope while no org is chosen.
    expect(mockedApi.get.mock.calls.map(([u]) => u as string).filter((u) => u.startsWith('/cab/'))).toHaveLength(0);
  });

  it('keeps the New change action out of the settings tab', async () => {
    asUser({}, ['change.create', 'cab.manage']);
    render(<ChangesPage />);
    expect(screen.getByRole('button', { name: /new change/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /cab settings/i }));
    expect(screen.queryByRole('button', { name: /new change/i })).not.toBeInTheDocument();
  });
});

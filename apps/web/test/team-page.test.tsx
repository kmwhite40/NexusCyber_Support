// The /team (Platform users) page, as seen by a delegated admin — admin.users.manage
// without admin.superuser.
//
// The API only lets a delegated admin grant within their own org scope and refuses them a
// SuperAdmin or all-organizations user outright. The page used to offer every org and open
// every user for editing, so those refusals only surfaced as a failed save.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamPage from '@/app/(app)/team/page';
import { api, type Me, type PlatformUser } from '@/lib/api';

const authState = { me: null as Me | null, can: (_p: string) => false };

vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({ ...authState, loading: false, refresh: vi.fn(), logout: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() };
  // The real clients close over the module's own `api`, so they are re-pointed at the mock.
  return {
    ...actual,
    api: mock,
    platformUsersApi: { ...actual.platformUsersApi, list: () => mock.get('/platform/users') },
    customersApi: { ...actual.customersApi, list: () => mock.get('/organizations').then((r: { data: unknown }) => r.data) },
  };
});
const mockedApi = vi.mocked(api, true);

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

function platformUser(over: Partial<PlatformUser>): PlatformUser {
  return {
    id: 'u-x', email: 'x@nexus.example', display_name: null, status: 'active', has_password: false,
    sso_linked: false, roles: ['Tier1'], all_orgs: false, org_ids: [ORG_A], created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const USERS: PlatformUser[] = [
  platformUser({ id: 'u-t1', email: 'tier1@nexus.example', display_name: 'Tess Tier1' }),
  platformUser({ id: 'u-sa', email: 'root@nexus.example', display_name: 'Sam Super', roles: ['SuperAdmin'], org_ids: [ORG_A] }),
  platformUser({ id: 'u-all', email: 'all@nexus.example', display_name: 'Avery AllOrgs', roles: ['Tier2'], org_ids: [], all_orgs: true }),
  platformUser({ id: 'u-b', email: 'b@nexus.example', display_name: 'Blake OrgB', org_ids: [ORG_B] }),
];

function asDelegatedAdmin(over: Partial<Me>) {
  authState.me = {
    id: 'me', plane: 'nexus', email: 'sdm@nexus.example', organization_id: null,
    roles: ['ServiceDeskManager'], capabilities: ['admin.users.manage'], assigned_orgs: [], all_orgs: false, ...over,
  } as Me;
  authState.can = (p: string) => p === 'admin.users.manage';
}

async function openNewUser() {
  render(<TeamPage />);
  await screen.findByText('Tess Tier1');
  await userEvent.click(screen.getByRole('button', { name: /new platform user/i }));
  return screen.getByRole('dialog');
}

describe('TeamPage for a delegated admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockImplementation((url: string) => {
      if (url === '/platform/users') return Promise.resolve({ data: USERS, assignable_roles: ['Tier1', 'Tier2', 'SecurityAnalyst', 'ServiceDeskManager'] });
      if (url.startsWith('/organizations')) return Promise.resolve({ data: [{ id: ORG_A, name: 'Acme Federal' }, { id: ORG_B, name: 'Globex' }] });
      return Promise.resolve({ data: [] });
    });
  });

  it('offers only the organizations the admin manages', async () => {
    asDelegatedAdmin({ assigned_orgs: [ORG_A] });
    const dialog = await openNewUser();
    expect(within(dialog).getByRole('checkbox', { name: 'Acme Federal' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'Globex' })).not.toBeInTheDocument();
  });

  it('offers every organization to an all-organizations admin', async () => {
    asDelegatedAdmin({ all_orgs: true });
    const dialog = await openNewUser();
    expect(within(dialog).getByRole('checkbox', { name: 'Acme Federal' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Globex' })).toBeInTheDocument();
  });

  it.each([
    ['Sam Super', /only a superadmin can manage/i],
    ['Avery AllOrgs', /only a superadmin can manage/i],
  ])('explains up front that %s is read-only, rather than failing on save', async (name, why) => {
    asDelegatedAdmin({ all_orgs: true });
    render(<TeamPage />);
    await userEvent.click(await screen.findByText(name));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(why)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /delete account/i })).not.toBeInTheDocument();
  });

  it('marks a user in an organization outside the admin’s scope read-only', async () => {
    asDelegatedAdmin({ assigned_orgs: [ORG_A] });
    render(<TeamPage />);
    await userEvent.click(await screen.findByText('Blake OrgB'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/outside your organization scope/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  it('still opens an in-scope user for editing', async () => {
    asDelegatedAdmin({ assigned_orgs: [ORG_A] });
    render(<TeamPage />);
    await userEvent.click(await screen.findByText('Tess Tier1'));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });
});

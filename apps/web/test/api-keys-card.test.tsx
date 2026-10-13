// The API-key card is the only way to mint an M2M credential without a shell. Two things it
// must get right, both of which have bitten this codebase before:
//   1. GET /integration/api-keys is enveloped as { data: [...] } while POST is not. Treating
//      them the same renders `undefined.map` (see provisioning-panel.test.tsx for the original).
//   2. The secret exists exactly once, in the create response. If the card re-renders it from
//      list state, or keeps it after dismissal, it is claiming to show something it cannot read.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeysCard } from '@/components/api-keys-card';
import { apiKeysApi } from '@/lib/api';

// `apiKeysApi` closes over lib/api's own module-local `api`, so replacing the exported `api`
// (the pattern in provisioning-panel.test.tsx, which calls `api.post` directly) would not reach
// it — the real fetch would run. Mock the typed client for component behaviour, and cover the
// envelope contract separately at the fetch boundary, below.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    apiKeysApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
  };
});

const mockedApi = vi.mocked(apiKeysApi, true);
const ORG = '5793f502-d09f-4882-9b7a-06ecec1b4e08';

const existingKey = {
  id: 'k-1', organization_id: ORG, key_id: 'abc123', name: 'Existing sync',
  scopes: ['ticket.create'], created_at: '2026-10-01T00:00:00Z',
  last_used_at: null, expires_at: null, revoked_at: null,
};

describe('ApiKeysCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.list.mockResolvedValue([existingKey]);
  });

  it('unwraps the { data: [...] } envelope and lists existing keys', async () => {
    render(<ApiKeysCard organizationId={ORG} canManage />);
    expect(await screen.findByText('Existing sync')).toBeTruthy();
    expect(screen.getByText(/abc123/)).toBeTruthy();
  });

  it('shows the secret exactly once after creating a key', async () => {
    mockedApi.create.mockResolvedValue({
      id: 'k-2', organization_id: ORG, key_id: 'new99', name: 'Carbon ConMon sync',
      scopes: ['ticket.create'], created_at: '2026-10-13T00:00:00Z', expires_at: null,
      token: 'ak_new99_supersecretvalue',
    });
    const user = userEvent.setup();
    render(<ApiKeysCard organizationId={ORG} canManage />);
    await screen.findByText('Existing sync');

    await user.type(screen.getByLabelText(/key name/i), 'Carbon ConMon sync');
    await user.click(screen.getByRole('button', { name: /create key/i }));

    expect(await screen.findByText('ak_new99_supersecretvalue')).toBeTruthy();
    expect(mockedApi.create).toHaveBeenCalledWith({ organizationId: ORG, name: 'Carbon ConMon sync' });
  });

  it('warns that the secret cannot be retrieved again', async () => {
    mockedApi.create.mockResolvedValue({ id: 'k-2', organization_id: ORG, key_id: 'new99', name: 'x', scopes: [], created_at: '', expires_at: null, token: 'ak_new99_s' });
    const user = userEvent.setup();
    render(<ApiKeysCard organizationId={ORG} canManage />);
    await screen.findByText('Existing sync');
    await user.type(screen.getByLabelText(/key name/i), 'Probe key');
    await user.click(screen.getByRole('button', { name: /create key/i }));
    expect(await screen.findByText(/only time/i)).toBeTruthy();
  });

  it('forgets the secret once dismissed, and never re-renders it from list state', async () => {
    mockedApi.create.mockResolvedValue({ id: 'k-2', organization_id: ORG, key_id: 'new99', name: 'x', scopes: [], created_at: '', expires_at: null, token: 'ak_new99_s' });
    const user = userEvent.setup();
    render(<ApiKeysCard organizationId={ORG} canManage />);
    await screen.findByText('Existing sync');
    await user.type(screen.getByLabelText(/key name/i), 'Probe key');
    await user.click(screen.getByRole('button', { name: /create key/i }));
    await screen.findByText('ak_new99_s');

    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByText('ak_new99_s')).toBeNull());
  });

  it('refuses to submit an empty key name rather than posting one', async () => {
    const user = userEvent.setup();
    render(<ApiKeysCard organizationId={ORG} canManage />);
    await screen.findByText('Existing sync');
    await user.click(screen.getByRole('button', { name: /create key/i }));
    expect(mockedApi.create).not.toHaveBeenCalled();
  });

  it('hides the create form entirely without the manage permission', async () => {
    render(<ApiKeysCard organizationId={ORG} canManage={false} />);
    await screen.findByText('Existing sync');
    expect(screen.queryByRole('button', { name: /create key/i })).toBeNull();
  });
});


// The contract the component depends on and cannot itself prove: the list route is enveloped
// as { data: [...] } while create is not, and request() does not unwrap. Exercised against the
// real apiKeysApi with only fetch stubbed, so a "tidying" change that makes both uniform fails.
describe('apiKeysApi envelope handling', () => {
  it('unwraps the list envelope into a bare array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200, ok: true, text: async () => JSON.stringify({ data: [existingKey] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const realApi = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    await expect(realApi.apiKeysApi.list(ORG)).resolves.toEqual([existingKey]);
    vi.unstubAllGlobals();
  });

  it('does NOT unwrap the create response, which is not enveloped', async () => {
    const created = { id: 'k-9', organization_id: ORG, key_id: 'z', name: 'n', scopes: [], created_at: '', expires_at: null, token: 'ak_z_s' };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201, ok: true, text: async () => JSON.stringify(created),
    });
    vi.stubGlobal('fetch', fetchMock);
    const realApi = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    await expect(realApi.apiKeysApi.create({ organizationId: ORG, name: 'n' })).resolves.toEqual(created);
    vi.unstubAllGlobals();
  });
});


describe('ApiKeysCard — name guard', () => {
  it('refuses a one-character name with an explanation rather than posting it', async () => {
    mockedApi.list.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<ApiKeysCard organizationId={ORG} canManage />);
    await user.type(screen.getByLabelText(/key name/i), 'x');
    await user.click(screen.getByRole('button', { name: /create key/i }));
    expect(mockedApi.create).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

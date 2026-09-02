// CabBoardSettings — the CAB administration screen.
//
// The load-bearing assertion here is that EVERY request names an organizationId. On the
// API side an omitted organizationId means the GLOBAL row inherited by every tenant,
// which is refused without `cab.manage.global` — a permission only SuperAdmin holds — so
// a settings screen that omits it 403s for every ordinary org admin. The rest guards the
// { data } unwrap on the board/blackout/template reads and the over-quorum warning, which
// is where a clamped (weakened) vote gets prevented rather than merely reported.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CabBoardSettings } from '@/app/(app)/changes/_components/cab-board-settings';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() };
  return {
    ...actual,
    api: mock,
    // The typed helpers in lib/api are thin wrappers over the same transport; re-point
    // them at the mock so the component's user lookups are observable here too.
    users: { search: (q: string, organizationId?: string) => mock.get(`/users/search?q=${q}&organizationId=${organizationId}`) },
    platformUsersApi: { ...actual.platformUsersApi, list: () => mock.get('/platform/users') },
  };
});
const mockedApi = vi.mocked(api, true);

const ORG = '55555555-5555-5555-5555-555555555555';
const ALICE = '66666666-6666-6666-6666-666666666666';
const BOB = '77777777-7777-7777-7777-777777777777';

/** Route the component's reads by URL, so ordering never matters. */
function routeGet(over: Record<string, unknown> = {}) {
  mockedApi.get.mockImplementation((url: string) => {
    if (url.startsWith('/cab/board')) return Promise.resolve(over['board'] ?? { data: { organization_id: ORG, name: 'Change Advisory Board', quorum: 2, threshold: 'majority', members: [{ user_id: ALICE, role: 'chair', weight: 1 }] } });
    if (url.startsWith('/cab/blackouts')) return Promise.resolve(over['blackouts'] ?? { data: [] });
    if (url.startsWith('/cab/templates')) return Promise.resolve(over['templates'] ?? { data: [] });
    if (url.startsWith('/users/search')) return Promise.resolve({ data: [{ id: BOB, display_name: 'Bob Member', email: 'bob@example.gov' }] });
    if (url.startsWith('/platform/users')) return Promise.resolve({ data: [{ id: ALICE, display_name: 'Alice Chair', email: 'alice@sbsfederal.com' }] });
    return Promise.resolve({ data: [] });
  });
}

function renderSettings(props: Partial<React.ComponentProps<typeof CabBoardSettings>> = {}) {
  return render(
    <CabBoardSettings
      organizationId={ORG}
      orgOptions={[]}
      onOrganizationChange={vi.fn()}
      canListPlatformUsers
      {...props}
    />,
  );
}

describe('CabBoardSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeGet();
    mockedApi.put.mockResolvedValue({ data: { organization_id: ORG, name: 'Change Advisory Board', quorum: 2, threshold: 'majority', members: [] } });
    mockedApi.post.mockResolvedValue({});
    mockedApi.del.mockResolvedValue({ deleted: true });
  });

  it('names the organization on every CAB read', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    const cabReads = mockedApi.get.mock.calls.map(([u]) => u as string).filter((u) => u.startsWith('/cab/'));
    expect(cabReads.length).toBeGreaterThanOrEqual(3); // board, blackouts, templates
    for (const url of cabReads) expect(url).toContain(`organizationId=${ORG}`);
  });

  it('sends organizationId in the board save body', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /save board/i }));
    await waitFor(() => expect(mockedApi.put).toHaveBeenCalled());

    const [url, body] = mockedApi.put.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/cab/board');
    // Not merely present: an explicit org id. `undefined` or null here means GLOBAL.
    expect(body.organizationId).toBe(ORG);
  });

  it('unwraps the board envelope into the form and the member list', async () => {
    renderSettings();
    // Against `setBoard(res)` instead of `setBoard(res.data)` none of these are populated.
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());
    expect(screen.getByDisplayValue('2')).toBeInTheDocument();
    expect(await screen.findByText(/alice chair/i)).toBeInTheDocument();
    expect(screen.getByText('chair')).toBeInTheDocument();
  });

  it('saves the members and chair the admin actually chose', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    await userEvent.selectOptions(await screen.findByLabelText(/add a board member/i), BOB);
    await userEvent.click(screen.getByRole('button', { name: /save board/i }));
    await waitFor(() => expect(mockedApi.put).toHaveBeenCalled());

    const body = mockedApi.put.mock.calls[0][1] as { members: Array<{ userId: string; role: string }>; chairId: string };
    expect(body.members).toEqual([
      { userId: ALICE, role: 'chair' },
      { userId: BOB, role: 'member' },
    ]);
    expect(body.chairId).toBe(ALICE);
  });

  it('warns when the quorum exceeds the roster it would be clamped to', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());
    // One member, quorum 2 as loaded: unreachable, so the vote would run clamped.
    expect(screen.getByText(/cannot be reached by 1 member/i)).toBeInTheDocument();

    const quorum = screen.getByLabelText('Quorum');
    await userEvent.clear(quorum);
    await userEvent.type(quorum, '1');
    expect(screen.queryByText(/cannot be reached/i)).not.toBeInTheDocument();
  });

  it('sends organizationId when creating a blackout window', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Blackout name'), 'Year-end freeze');
    await userEvent.type(screen.getByLabelText('Blackout starts'), '2026-12-20T00:00');
    await userEvent.type(screen.getByLabelText('Blackout ends'), '2027-01-02T00:00');
    await userEvent.click(screen.getByRole('button', { name: /add blackout window/i }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    const [url, body] = mockedApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/cab/blackouts');
    expect(body).toMatchObject({ organizationId: ORG, name: 'Year-end freeze' });
  });

  it('refuses to submit a blackout whose window ends before it starts', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Blackout name'), 'Backwards');
    await userEvent.type(screen.getByLabelText('Blackout starts'), '2027-01-02T00:00');
    await userEvent.type(screen.getByLabelText('Blackout ends'), '2026-12-20T00:00');
    expect(screen.getByRole('button', { name: /add blackout window/i })).toBeDisabled();
  });

  it('sends organizationId when creating a template', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Template name'), 'Standard patch');
    await userEvent.click(screen.getByRole('button', { name: /add template/i }));

    await waitFor(() => expect(mockedApi.post).toHaveBeenCalled());
    const [url, body] = mockedApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/cab/templates');
    expect(body).toMatchObject({ organizationId: ORG, name: 'Standard patch' });
  });

  it('labels inherited global rows so an admin knows they are platform-wide', async () => {
    routeGet({
      blackouts: { data: [{ id: 'b1', organization_id: null, name: 'Fiscal year end', starts_at: '2026-09-25T00:00:00.000Z', ends_at: '2026-10-02T00:00:00.000Z', reason: null }] },
      templates: { data: [{ id: 't1', organization_id: ORG, name: 'Standard patch', change_type: 'standard', risk: 'low', impact: null, likelihood: null, description: null, implementation_plan: null, test_plan: null, backout_plan: null }] },
    });
    renderSettings();

    expect(await screen.findByText('Fiscal year end')).toBeInTheDocument();
    expect(screen.getAllByText('global')).toHaveLength(1); // the blackout, not the org template
  });

  it('surfaces a refused save rather than looking like it worked', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    mockedApi.put.mockRejectedValue(new ApiError(403, 'global CAB configuration requires cab.manage.global'));
    renderSettings();
    await waitFor(() => expect(screen.getByDisplayValue('Change Advisory Board')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /save board/i }));
    expect(await screen.findByText(/cab\.manage\.global/i)).toBeInTheDocument();
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('asks a nexus admin to pick an organization before issuing any CAB call', () => {
    renderSettings({ organizationId: null, orgOptions: [{ id: ORG, name: 'Acme Federal' }] });
    expect(screen.getByRole('option', { name: 'Acme Federal' })).toBeInTheDocument();
    expect(mockedApi.get.mock.calls.filter(([u]) => (u as string).startsWith('/cab/'))).toHaveLength(0);
  });
});

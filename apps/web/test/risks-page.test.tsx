// The /risks page: organization separation in the UI, heat-map filtering, and the create flow.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RisksPage from '@/app/(app)/risks/page';
import { api, type Me } from '@/lib/api';
import { ratingFor, heatmap, money, type Risk } from '@/lib/risks';

const authState = { me: null as Me | null, can: (_p: string) => false };
vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({ ...authState, loading: false, refresh: vi.fn(), logout: vi.fn() }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
const mockedApi = vi.mocked(api, true);

const ACME = '11111111-1111-1111-1111-111111111111';
const GLOBEX = '22222222-2222-2222-2222-222222222222';

function asUser(over: Partial<Me>, caps: string[]) {
  authState.me = { id: 'u1', plane: 'customer', email: 'a@acme.gov', organization_id: ACME, roles: [], capabilities: caps, ...over } as Me;
  authState.can = (p: string) => caps.includes(p);
}

function risk(over: Partial<Risk>): Risk {
  const rl = over.residual_likelihood ?? 3;
  const ri = over.residual_impact ?? 4;
  return {
    id: 'r1', organization_id: ACME, risk_number: 1, ref: 'R-0001', title: 'Ransomware', description: null, cause: null,
    event: null, consequence: null, category: 'cybersecurity', threat_source: null, status: 'assessed', strategy: null,
    owner_id: null, owner_name: null, owner: null,
    inherent_likelihood: 4, inherent_impact: 5, inherent_score: 20,
    residual_likelihood: rl, residual_impact: ri, residual_score: rl * ri,
    target_likelihood: null, target_impact: null, target_score: null,
    inherent_rating: 'very_high', residual_rating: ratingFor(rl * ri), target_rating: null,
    impact_dimensions: {}, velocity: null, fair_inputs: null, fair_results: null, review_frequency_days: null,
    last_reviewed_at: '2026-11-01T00:00:00Z', next_review_at: '2027-01-01T00:00:00Z', review_overdue: false,
    appetite_state: rl * ri > 9 ? 'above_appetite' : 'within',
    acceptance_status: 'none', acceptance_justification: null, acceptance_expires_at: null, acceptance_requested_by: null,
    acceptance_active: false, tags: [], treatment_progress: null, created_at: '', updated_at: '',
    ...over,
  };
}

const SETTINGS = { organization_id: ACME, appetite_score: 9, tolerance_score: 15, max_acceptance_days: 365, is_default: true };
const RISKS = [
  risk({ id: 'r1', ref: 'R-0001', title: 'Ransomware via phishing' }),
  risk({ id: 'r2', ref: 'R-0002', risk_number: 2, title: 'Vendor SOC 2 lapsed', residual_likelihood: 1, residual_impact: 2, category: 'third_party' }),
];

describe('RisksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockImplementation((url: string) => {
      if (url.startsWith('/organizations')) return Promise.resolve({ data: [{ id: ACME, name: 'Acme Federal' }, { id: GLOBEX, name: 'Globex' }] });
      if (url === '/risks/portfolio') {
        return Promise.resolve({
          data: [
            { organization_id: GLOBEX, organization_name: 'Globex', open: 4, by_rating: { very_low: 0, low: 1, moderate: 1, high: 1, very_high: 1 }, above_appetite: 2, above_tolerance: 1, overdue_reviews: 1, worst_residual: 20, ale_p50: 1_200_000, ale_p90: 4_000_000, quantified: 2, appetite_score: 9, tolerance_score: 15 },
            { organization_id: ACME, organization_name: 'Acme Federal', open: 2, by_rating: { very_low: 1, low: 0, moderate: 1, high: 0, very_high: 0 }, above_appetite: 1, above_tolerance: 0, overdue_reviews: 0, worst_residual: 12, ale_p50: null, ale_p90: null, quantified: 0, appetite_score: 9, tolerance_score: 15 },
          ],
        });
      }
      if (url.startsWith('/risks/settings')) return Promise.resolve(SETTINGS);
      // Single-risk read (the detail dialog opens after a create): answered bare, not enveloped.
      if (/^\/risks\/r-/.test(url)) {
        return Promise.resolve({ ...risk({ id: 'r-new' }), settings: SETTINGS, treatments: [], links: [], history: [], treatments_overdue: 0, acceptance_requested_by_user: null, acceptance_decided_by_user: null });
      }
      if (url.startsWith('/risks')) return Promise.resolve({ data: RISKS });
      return Promise.resolve({ data: [] });
    });
  });

  it('shows staff a per-organization portfolio, worst first, and opens one organization\'s register', async () => {
    asUser({ plane: 'nexus', organization_id: null }, ['risk.read', 'risk.manage']);
    render(<RisksPage />);

    const cards = await screen.findAllByRole('button', { name: /risk register$/ });
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Open Globex risk register', 'Open Acme Federal risk register']);
    expect(within(cards[1]).getByText('not quantified')).toBeTruthy(); // null exposure is not $0

    await userEvent.click(cards[1]);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^/risks\\?organizationId=${ACME}`))));
    expect(await screen.findByText('Ransomware via phishing')).toBeTruthy();
    // Every register call names the organization: nothing is pooled across tenants.
    const registerCalls = mockedApi.get.mock.calls.map(([u]) => u as string).filter((u) => /^\/risks(\?|\/settings)/.test(u));
    expect(registerCalls.every((u) => u.includes(`organizationId=${ACME}`))).toBe(true);
  });

  it('gives a customer their own register with no organization switcher', async () => {
    asUser({}, ['risk.read']);
    render(<RisksPage />);
    expect(await screen.findByText('Ransomware via phishing')).toBeTruthy();
    expect(screen.queryByLabelText('Organization')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New risk' })).toBeNull(); // read-only role
    expect(mockedApi.get).not.toHaveBeenCalledWith('/risks/portfolio');
    expect(mockedApi.get.mock.calls.some(([u]) => String(u).includes('organizationId'))).toBe(false);
  });

  it('filters the register by heat-map cell', async () => {
    asUser({}, ['risk.read']);
    render(<RisksPage />);
    await screen.findByText('Vendor SOC 2 lapsed');
    await userEvent.click(screen.getByRole('gridcell', { name: /Likelihood Possible, impact Major, score 12: 1 risk/ }));
    expect(screen.queryByText('Vendor SOC 2 lapsed')).toBeNull();
    expect(screen.getByText('Ransomware via phishing')).toBeTruthy();
  });

  it('creates a risk in the selected organization', async () => {
    mockedApi.post.mockResolvedValue(risk({ id: 'r-new' }));
    asUser({ plane: 'nexus', organization_id: null }, ['risk.read', 'risk.manage']);
    render(<RisksPage />);
    await userEvent.selectOptions(await screen.findByLabelText('Organization'), GLOBEX);
    await userEvent.click(await screen.findByRole('button', { name: 'New risk' }));
    await userEvent.type(screen.getByLabelText('Title'), 'Unpatched VPN appliance');
    await userEvent.click(screen.getAllByRole('radio', { name: 'Likelihood Likely, impact Severe, score 20' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Add to register' }));
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledWith('/risks', expect.objectContaining({
      organizationId: GLOBEX, title: 'Unpatched VPN appliance', inherentLikelihood: 4, inherentImpact: 5,
    })));
  });
});

describe('lib/risks helpers', () => {
  it('bands scores like the API', () => {
    expect([3, 4, 8, 15, 20].map(ratingFor)).toEqual(['very_low', 'low', 'moderate', 'high', 'very_high']);
  });
  it('builds a heat map that skips closed risks', () => {
    const g = heatmap([RISKS[0], { ...RISKS[0], status: 'closed' }], 'residual');
    expect(g[2][3]).toBe(1);
  });
  it('formats money compactly', () => {
    expect(money(1_250_000)).toBe('$1.3M');
    expect(money(45_000)).toBe('$45K');
    expect(money(null)).toBe('—');
  });
});

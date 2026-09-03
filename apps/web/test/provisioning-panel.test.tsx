// Regression test for the envelope-unwrap bug: every route in apps/api/src/http/routes.ts
// wraps its payload as `{ data: ... }`, and apps/web/lib/api.ts's request() returns the raw
// parsed body unwrapped. A generic like `api.post<Plan>(...)` compiles fine but is simply
// wrong — `res` is `{ data: Plan }`, not `Plan` — and TypeScript cannot catch it because
// generics carry no runtime check. The previous incident: preview() called
// `api.post<Plan>(...)` and did `setPlan(res)`, so `plan.steps` was `undefined` and the
// `.map` in the JSX below threw a TypeError on every successful preview click.
//
// This test renders the real ProvisioningPanel, drives an actual Preview click through a
// mocked api.post that returns the real `{ data: Plan }` envelope, and asserts the plan's
// steps end up on the screen. Against the pre-fix `setPlan(res)` code this throws inside
// the render triggered by the click and the test fails; see the task report for the
// before/after run transcript.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvisioningPanel } from '@/components/provisioning-panel';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockedApi = vi.mocked(api, true);

describe('ProvisioningPanel — preview envelope unwrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prior runs — keeps the "latest run" status block out of the way of this test.
    mockedApi.get.mockResolvedValue({ data: [] });
  });

  it('unwraps the { data: Plan } envelope and renders the plan steps', async () => {
    mockedApi.post.mockResolvedValue({
      data: {
        upn: 'jdoe@sbsfederal.com',
        displayName: 'Jane Doe',
        steps: [
          { key: 'create_account', label: 'Create Entra ID account', detail: {} },
          { key: 'assign_license', label: 'Assign Windows 365 license', detail: {} },
        ],
        blockers: [],
        fingerprint: 'fp-123',
      },
    });

    render(<ProvisioningPanel ticketId="TCK-1" canProvision />);

    // Wait for the run-history load (loadRuns, on mount) so it isn't still in flight when
    // we click Preview.
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledTimes(1));

    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));

    // If preview() did `setPlan(res)` instead of `setPlan(res.data)`, `plan` would be the
    // envelope object, `plan.steps` would be `undefined`, and this `.map` would throw
    // during render — the component would never reach these assertions.
    expect(await screen.findByText('Create Entra ID account')).toBeInTheDocument();
    expect(screen.getByText('Assign Windows 365 license')).toBeInTheDocument();
    expect(screen.getByText('jdoe@sbsfederal.com')).toBeInTheDocument();

    // The Provision button should be enabled: the plan carries no blockers and has a
    // fingerprint, and no run is in flight.
    expect(screen.getByRole('button', { name: /^provision$/i })).toBeEnabled();
  });
});

// The panel used to render an unconditional Preview button. On a deployment where
// M365_PROV_ENABLED is off (which is every deployment until the SBS tenant prerequisites are
// done) that button's ONLY possible outcome was a 400 "provisioning is not enabled on this
// deployment" — so "the feature is not turned on here" and "provisioning is broken" produced
// the same experience: click, red text. The runs endpoint now reports the flag, and these
// tests pin that the panel says which one it is BEFORE anything is clicked.
describe('ProvisioningPanel — feature-off state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says the feature is not configured, and offers no button that could only fail', async () => {
    mockedApi.get.mockResolvedValue({ data: [], provisioningEnabled: false });

    render(<ProvisioningPanel ticketId="TCK-1" canProvision />);

    expect(await screen.findByText(/not configured on this deployment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument();
  });

  it('still shows the run history when the feature is switched off after a run', async () => {
    // listRuns is deliberately not gated on the flag (apps/api/src/modules/provisioning/index.ts):
    // turning the feature off must not erase the compliance record of what it did while on. The
    // panel has to honour that — hiding the controls must not hide the history with them.
    mockedApi.get.mockResolvedValue({
      data: [{
        id: 'run-1', status: 'succeeded', error: null, started_at: null, finished_at: null,
        steps: [{ step_key: 'create_account', status: 'succeeded', error: null }],
      }],
      provisioningEnabled: false,
    });

    render(<ProvisioningPanel ticketId="TCK-1" canProvision />);

    expect(await screen.findByText(/^Succeeded$/)).toBeInTheDocument();
    expect(screen.getByText('create account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument();
  });

  it('offers Preview normally when the feature is on', async () => {
    mockedApi.get.mockResolvedValue({ data: [], provisioningEnabled: true });

    render(<ProvisioningPanel ticketId="TCK-1" canProvision />);

    expect(await screen.findByRole('button', { name: /preview/i })).toBeInTheDocument();
    expect(screen.queryByText(/not configured on this deployment/i)).not.toBeInTheDocument();
  });
});

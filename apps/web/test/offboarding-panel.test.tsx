import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OffboardingPanel } from '@/components/offboarding-panel';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
const mockedApi = vi.mocked(api, true);

const PLAN = {
  upn: 'jane.doe@sbsfederal.com',
  currentDisplayName: 'Jane Doe',
  inactiveName: 'ZZ_Inactive_Doe_Jane_2026-09-02',
  privileged: false,
  blockers: [],
  fingerprint: 'fp-1',
  steps: [
    { key: 'block_signin', label: 'Block sign-in', manual: false, detail: {} },
    { key: 'convert_shared_mailbox', label: 'Convert mailbox to shared', manual: true, detail: {} },
  ],
};

beforeEach(() => { vi.clearAllMocks(); });

describe('OffboardingPanel', () => {
  it('says the feature is not configured rather than offering a dead button', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: false });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    expect(await screen.findByText(/not configured on this deployment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument();
  });

  it('renders nothing at all without the permission', () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    const { container } = render(<OffboardingPanel ticketId="T-1" canOffboard={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockedApi.get).not.toHaveBeenCalled();
  });

  it('unwraps the { data: Plan } envelope and renders the steps and the new name', async () => {
    // The same envelope bug the provisioning panel test exists to catch: api.post returns the
    // raw body, so a generic of <Plan> compiles and is still wrong.
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: PLAN });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText('Block sign-in')).toBeInTheDocument();
    expect(screen.getByText(/ZZ_Inactive_Doe_Jane_2026-09-02/)).toBeInTheDocument();
  });

  it('marks the mailbox conversion as a manual step the tech must perform', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: PLAN });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/manual/i)).toBeInTheDocument();
  });

  it('disables Schedule while the plan carries a blocker', async () => {
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({
      data: { ...PLAN, blockers: [{ code: 'legal_hold', message: 'Legal hold is set.' }] },
    });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/Legal hold is set\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /schedule/i })).toBeDisabled();
  });

  it('disables Schedule until a disable time has been chosen', async () => {
    // Scheduling with no instant would either fail server-side or, worse, imply "now" — on a
    // termination that is not a default anyone should get by omission.
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: PLAN });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(screen.getByRole('button', { name: /schedule/i })).toBeDisabled();
  });

  it('warns visibly when the account is privileged', async () => {
    // Privileged means the 7-year retention path, not the 1-year default. The person arming the
    // run should not have to infer that from the step list.
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post.mockResolvedValue({ data: { ...PLAN, privileged: true } });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/privileged/i)).toBeInTheDocument();
  });

  it('surfaces a 412 as a plain instruction to preview again', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    mockedApi.get.mockResolvedValue({ data: [], offboardingEnabled: true });
    mockedApi.post
      .mockResolvedValueOnce({ data: PLAN })
      .mockRejectedValueOnce(new ApiError(412, 'stale'));
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await userEvent.click(await screen.findByRole('button', { name: /preview/i }));
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    await userEvent.type(input, '2099-01-01T09:00');
    await userEvent.click(screen.getByRole('button', { name: /schedule/i }));
    expect(await screen.findByText(/changed since you previewed/i)).toBeInTheDocument();
  });

  it('still shows run history when the feature is switched off after a run', async () => {
    // listRuns is deliberately not gated on the flag: turning offboarding off must not erase the
    // record of what it did while on.
    mockedApi.get.mockResolvedValue({
      data: [{
        id: 'run-1', status: 'needs_review', error: 'waiting on the manual mailbox conversion',
        scheduled_for: null, started_at: null, finished_at: null, steps: [],
      }],
      offboardingEnabled: false,
    });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    expect(await screen.findByText(/needs review/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting on the manual mailbox conversion/)).toBeInTheDocument();
  });
});

describe('OffboardingPanel — cancelling an armed run', () => {
  const scheduledRun = {
    data: [{
      id: 'run-1', status: 'scheduled', error: null,
      scheduled_for: '2099-01-01T09:00:00.000Z', started_at: null, finished_at: null, steps: [],
    }],
    offboardingEnabled: true,
  };

  it('offers a way to stop a run that is armed', async () => {
    mockedApi.get.mockResolvedValue(scheduledRun);
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    expect(await screen.findByRole('button', { name: /cancel run/i })).toBeInTheDocument();
  });

  it('requires a reason before it will cancel', async () => {
    // The run history is the record of why a termination did not happen. "Cancelled" with no
    // reason is the least useful entry it could contain.
    mockedApi.get.mockResolvedValue(scheduledRun);
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    expect(await screen.findByRole('button', { name: /cancel run/i })).toBeDisabled();
  });

  it('sends the reason and refreshes the history', async () => {
    mockedApi.get.mockResolvedValue(scheduledRun);
    mockedApi.post.mockResolvedValue({ data: { cancelled: 1 } });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    const reason = await screen.findByPlaceholderText(/why/i);
    await userEvent.type(reason, 'start date moved');
    await userEvent.click(screen.getByRole('button', { name: /cancel run/i }));
    expect(mockedApi.post).toHaveBeenCalledWith('/tickets/T-1/offboarding/cancel', { reason: 'start date moved' });
  });

  it('offers no cancel for a run that has already finished', async () => {
    mockedApi.get.mockResolvedValue({
      data: [{ id: 'run-1', status: 'succeeded', error: null, scheduled_for: null, started_at: null, finished_at: null, steps: [] }],
      offboardingEnabled: true,
    });
    render(<OffboardingPanel ticketId="T-1" canOffboard />);
    await screen.findByText(/succeeded/i);
    expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
  });
});

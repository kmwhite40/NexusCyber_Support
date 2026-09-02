// ChangeDetail — the composition around the vote panel.
//
// Guards: the plan tabs show the right plan (and say so when one is missing rather than
// rendering an empty box), the risk badge explains where the band came from, the PIR
// form appears exactly where the API allows a PIR and posts the outcome it collected,
// and the deliberation thread unwraps its { data } envelope.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeDetail } from '@/app/(app)/changes/_components/change-detail';
import type { ChangeRecord } from '@/lib/changes';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});
const mockedApi = vi.mocked(api, true);

const ME = '11111111-1111-1111-1111-111111111111';
const ALL = { create: true, vote: true, implement: true };

function makeChange(over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id: 'c1', title: 'Patch the edge firewall', change_type: 'normal', risk: 'high',
    status: 'draft', window_start: null, window_end: null,
    organization_id: 'org1', description: 'Quarterly firmware roll', impact: 'high', likelihood: 'medium',
    implementation_plan: 'Drain node, apply firmware, rejoin cluster',
    test_plan: null,
    backout_plan: 'Restore the prior firmware image from the vault',
    created_by: ME, created_at: '2026-06-01T00:00:00.000Z',
    cab_board_id: null, cab_quorum: null, cab_quorum_requested: null, cab_threshold: null,
    vote_deadline: null, pir_outcome: null, pir_notes: null, pir_at: null,
    cab_steps: [], votes: [], cab_tally: null, ...over,
  };
}

describe('ChangeDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.get.mockResolvedValue({ data: [] }); // comments thread
  });

  it('prompts for a selection when nothing is open', () => {
    render(<ChangeDetail change={null} meId={ME} perms={ALL} onChanged={vi.fn()} />);
    expect(screen.getByText(/nothing selected/i)).toBeInTheDocument();
  });

  it('switches between the implementation, test and backout plans', async () => {
    render(<ChangeDetail change={makeChange()} meId={ME} perms={ALL} onChanged={vi.fn()} />);
    expect(screen.getByText(/drain node, apply firmware/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Test' }));
    // A missing plan is stated, not rendered as an empty panel.
    expect(screen.getByText(/no test plan recorded/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Backout' }));
    expect(screen.getByText(/restore the prior firmware image/i)).toBeInTheDocument();
  });

  it('shows the risk band and the impact × likelihood it came from', () => {
    render(<ChangeDetail change={makeChange()} meId={ME} perms={ALL} onChanged={vi.fn()} />);
    expect(screen.getByText('high risk')).toBeInTheDocument();
    expect(screen.getByText(/high impact × medium likelihood/i)).toBeInTheDocument();
  });

  it('offers the PIR form only in review, and posts the outcome it collected', async () => {
    const onChanged = vi.fn();
    mockedApi.post.mockResolvedValue({ status: 'closed', pir_outcome: 'partial' });
    const { rerender } = render(
      <ChangeDetail change={makeChange({ status: 'implementing' })} meId={ME} perms={ALL} onChanged={onChanged} />,
    );
    expect(screen.queryByLabelText(/review outcome/i)).not.toBeInTheDocument();

    rerender(<ChangeDetail change={makeChange({ status: 'review' })} meId={ME} perms={ALL} onChanged={onChanged} />);
    await userEvent.selectOptions(screen.getByLabelText(/review outcome/i), 'partial');
    await userEvent.type(screen.getByLabelText(/review notes/i), 'cluster rejoined late');
    await userEvent.click(screen.getByRole('button', { name: /record review/i }));

    expect(mockedApi.post).toHaveBeenCalledWith('/changes/c1/pir', {
      outcome: 'partial',
      notes: 'cluster rejoined late',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('hides the PIR form from a viewer without change.implement', () => {
    render(
      <ChangeDetail
        change={makeChange({ status: 'review' })}
        meId={ME}
        perms={{ create: true, vote: true, implement: false }}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/review outcome/i)).not.toBeInTheDocument();
  });

  it('renders a recorded PIR outcome on a closed change', () => {
    render(
      <ChangeDetail
        change={makeChange({ status: 'closed', pir_outcome: 'rolled_back', pir_notes: 'firmware bricked the uplink' })}
        meId={ME}
        perms={ALL}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('rolled back')).toBeInTheDocument();
    expect(screen.getByText(/firmware bricked the uplink/i)).toBeInTheDocument();
  });

  it('unwraps the { data } envelope on the deliberation thread', async () => {
    mockedApi.get.mockResolvedValue({
      data: [{ id: 'k1', change_id: 'c1', author_id: 'u9', author_name: 'Dana Chair', body: 'Backout plan is thin.', created_at: '2026-06-02T10:00:00.000Z' }],
    });
    render(<ChangeDetail change={makeChange()} meId={ME} perms={ALL} onChanged={vi.fn()} />);

    // Against `setItems(res)` instead of `setItems(res.data)` the .map below throws.
    expect(await screen.findByText('Backout plan is thin.')).toBeInTheDocument();
    expect(screen.getByText('Dana Chair')).toBeInTheDocument();
  });

  it('offers Submit to CAB on a draft and Cancel to the raiser', () => {
    render(<ChangeDetail change={makeChange()} meId={ME} perms={{ create: true, vote: false, implement: false }} onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: /submit to cab/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel change/i })).toBeInTheDocument();
  });

  it('withholds Cancel from a bystander who neither raised the change nor implements changes', () => {
    render(
      <ChangeDetail
        change={makeChange({ created_by: 'someone-else' })}
        meId={ME}
        perms={{ create: true, vote: true, implement: false }}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /cancel change/i })).not.toBeInTheDocument();
  });

  it('does not offer Advance out of review — closing goes through the PIR', () => {
    render(<ChangeDetail change={makeChange({ status: 'review' })} meId={ME} perms={ALL} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /advance to/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record review/i })).toBeInTheDocument();
  });

  it('surfaces a refused lifecycle action instead of silently doing nothing', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    mockedApi.post.mockRejectedValue(new ApiError(400, 'no CAB voters: configure the board'));
    render(<ChangeDetail change={makeChange()} meId={ME} perms={ALL} onChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /submit to cab/i }));
    expect(await screen.findByText(/no CAB voters/i)).toBeInTheDocument();
  });
});

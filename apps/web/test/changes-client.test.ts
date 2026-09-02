// lib/changes.ts — the envelope contract and the pure tally helpers.
//
// apps/web/lib/api.ts returns the parsed body verbatim; it does NOT unwrap the
// `{ data: ... }` wrapper that the collection routes in apps/api/src/http/routes.ts
// return. Which routes wrap is per-route, TypeScript cannot check it (a generic carries
// no runtime check), and getting it wrong ships a component holding a wrapper — the
// exact bug that took down the provisioning preview. These tests pin the wrap/no-wrap
// decision of every call in the module against a mocked transport, so a route that
// changes shape breaks here rather than in a render.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  changesApi, cabApi, quorumProgress, quorumClamp, isRecusedRaiser, pendingBallotFor,
  statusTone, riskTone, type ChangeVote,
} from '@/lib/changes';
import { api } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});
const mockedApi = vi.mocked(api, true);

const ORG = '44444444-4444-4444-4444-444444444444';

describe('changes client — { data } envelope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unwraps the collection routes that wrap', async () => {
    mockedApi.get.mockResolvedValue({ data: [{ id: 'c1' }] });
    await expect(changesApi.list()).resolves.toEqual([{ id: 'c1' }]);
    await expect(changesApi.calendar('a', 'b')).resolves.toEqual([{ id: 'c1' }]);
    await expect(changesApi.comments('c1')).resolves.toEqual([{ id: 'c1' }]);

    mockedApi.get.mockResolvedValue({ data: { quorum: 2, members: [] } });
    await expect(cabApi.board(ORG)).resolves.toEqual({ quorum: 2, members: [] });
    mockedApi.get.mockResolvedValue({ data: [{ id: 'b1' }] });
    await expect(cabApi.blackouts(ORG)).resolves.toEqual([{ id: 'b1' }]);
    await expect(cabApi.templates(ORG)).resolves.toEqual([{ id: 'b1' }]);

    mockedApi.put.mockResolvedValue({ data: { quorum: 3, members: [] } });
    await expect(cabApi.saveBoard({ organizationId: ORG, quorum: 3 })).resolves.toEqual({ quorum: 3, members: [] });
  });

  it('does NOT unwrap the routes that return their payload bare', async () => {
    // GET /changes/:id and the lifecycle POSTs return the object directly; unwrapping
    // them would hand components `undefined`.
    mockedApi.get.mockResolvedValue({ id: 'c1', votes: [] });
    await expect(changesApi.get('c1')).resolves.toEqual({ id: 'c1', votes: [] });

    mockedApi.post.mockResolvedValue({ status: 'cab_review', tally: { cast: 1 } });
    await expect(changesApi.vote('c1', 'approve')).resolves.toEqual({ status: 'cab_review', tally: { cast: 1 } });
    mockedApi.post.mockResolvedValue({ status: 'cab_review', quorum_clamped: true });
    await expect(changesApi.submitCab('c1')).resolves.toMatchObject({ quorum_clamped: true });
  });

  it('sends an explicit organizationId on every CAB call', async () => {
    // Omitting it means GLOBAL server-side, which is refused without cab.manage.global —
    // i.e. a 403 for every ordinary org admin. These assertions are the regression guard.
    mockedApi.get.mockResolvedValue({ data: [] });
    mockedApi.put.mockResolvedValue({ data: {} });
    mockedApi.post.mockResolvedValue({});

    await cabApi.board(ORG);
    await cabApi.blackouts(ORG);
    await cabApi.templates(ORG);
    for (const [url] of mockedApi.get.mock.calls) {
      expect(url).toContain(`organizationId=${ORG}`);
    }

    await cabApi.saveBoard({ organizationId: ORG, quorum: 2 });
    expect(mockedApi.put).toHaveBeenCalledWith('/cab/board', { organizationId: ORG, quorum: 2 });

    await cabApi.createBlackout({ organizationId: ORG, name: 'freeze', startsAt: 'a', endsAt: 'b' });
    expect(mockedApi.post.mock.calls[0][1]).toMatchObject({ organizationId: ORG });
    await cabApi.createTemplate({ organizationId: ORG, name: 'tpl' });
    expect(mockedApi.post.mock.calls[1][1]).toMatchObject({ organizationId: ORG });
  });

  it('omits an empty vote reason rather than posting a blank string', async () => {
    mockedApi.post.mockResolvedValue({});
    await changesApi.vote('c1', 'abstain');
    expect(mockedApi.post).toHaveBeenCalledWith('/changes/c1/vote', { vote: 'abstain' });
  });
});

describe('quorumProgress', () => {
  const tally = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
  function base() {
    return { approve: 0, reject: 0, abstain: 0, pending: 0, cast: 0, roster: 0 };
  }

  it('reports progress toward the snapshotted quorum', () => {
    expect(quorumProgress(tally({ cast: 2, roster: 4, pending: 2 }), 3)).toMatchObject({
      cast: 2, quorum: 3, remaining: 1, met: false,
    });
  });

  it('treats cast >= quorum as met, matching the API resolver', () => {
    expect(quorumProgress(tally({ cast: 3, roster: 3 }), 3).met).toBe(true);
    expect(quorumProgress(tally({ cast: 4, roster: 4 }), 3)).toMatchObject({ met: true, remaining: 0 });
  });

  it('caps the bar at 100% and never divides by a zero quorum', () => {
    expect(quorumProgress(tally({ cast: 9 }), 2).pct).toBe(100);
    expect(quorumProgress(tally({ cast: 1 }), 0)).toMatchObject({ quorum: 1, met: true, pct: 100 });
    expect(quorumProgress(null, null)).toMatchObject({ cast: 0, quorum: 1, met: false, pct: 0 });
  });
});

describe('quorumClamp', () => {
  it('reports a quorum that was weakened below the board configuration', () => {
    expect(quorumClamp({ cab_quorum: 1, cab_quorum_requested: 3 })).toEqual({ effective: 1, requested: 3 });
  });

  it('reports nothing when the board got the quorum it asked for', () => {
    expect(quorumClamp({ cab_quorum: 2, cab_quorum_requested: 2 })).toBeNull();
  });

  it('reports nothing when the requested quorum was never recorded', () => {
    // Changes submitted before migration 0060 — "unknown", not "not clamped".
    expect(quorumClamp({ cab_quorum: 1, cab_quorum_requested: null })).toBeNull();
    expect(quorumClamp({ cab_quorum: null, cab_quorum_requested: null })).toBeNull();
  });
});

describe('roster helpers', () => {
  const ballot = (voter_id: string, vote: ChangeVote['vote'] = null): ChangeVote => ({
    id: `b-${voter_id}`, voter_id, vote, reason: null, weight: 1, ad_hoc: false, decided_at: null,
  });

  it('identifies the raiser as recused', () => {
    expect(isRecusedRaiser({ created_by: 'u1' }, 'u1')).toBe(true);
    expect(isRecusedRaiser({ created_by: 'u1' }, 'u2')).toBe(false);
    expect(isRecusedRaiser({ created_by: null }, 'u1')).toBe(false);
    expect(isRecusedRaiser({ created_by: 'u1' }, null)).toBe(false);
  });

  it('finds the viewer’s own ballot, cast or not', () => {
    const votes = [ballot('u1', 'approve'), ballot('u2')];
    expect(pendingBallotFor(votes, 'u2')).toMatchObject({ voter_id: 'u2', vote: null });
    expect(pendingBallotFor(votes, 'u1')).toMatchObject({ vote: 'approve' });
    expect(pendingBallotFor(votes, 'u3')).toBeNull();
    expect(pendingBallotFor(votes, null)).toBeNull();
  });
});

describe('tone helpers', () => {
  it('maps change status and risk onto badge tones', () => {
    expect(statusTone('approved')).toBe('success');
    expect(statusTone('closed')).toBe('success');
    expect(statusTone('rejected')).toBe('danger');
    expect(statusTone('cab_review')).toBe('warning');
    expect(statusTone('draft')).toBe('neutral');
    expect(riskTone('high')).toBe('danger');
    expect(riskTone('medium')).toBe('warning');
    expect(riskTone('low')).toBe('neutral');
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  setAccountEnabled, revokeSignInSessions, setDisplayName, removeLicenses, removeFromGroup,
} from '../src/integrations/m365/provisioning-graph.js';

// These assert the exact Graph calls the destructive steps make. They are worth pinning
// precisely because a wrong path or verb here does not fail loudly — it fails by doing nothing,
// or by doing something to the wrong object, on a live federal directory.
const clientDouble = () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    g: {
      get: vi.fn(async (path: string) => { calls.push({ method: 'GET', path }); return {}; }),
      post: vi.fn(async (path: string, body?: unknown) => { calls.push({ method: 'POST', path, body }); return {}; }),
      patch: vi.fn(async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return {}; }),
      del: vi.fn(async (path: string) => { calls.push({ method: 'DELETE', path }); return null; }),
    } as any,
  };
};

describe('offboarding graph ops', () => {
  it('disables the account by PATCHing accountEnabled false', async () => {
    const { g, calls } = clientDouble();
    await setAccountEnabled(g, 'u-1', false);
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/users/u-1', body: { accountEnabled: false } });
  });

  it('revokes sessions through the dedicated action, not by resetting a password', async () => {
    // A password reset does NOT invalidate existing refresh tokens. revokeSignInSessions does.
    const { g, calls } = clientDouble();
    await revokeSignInSessions(g, 'u-1');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/users/u-1/revokeSignInSessions' });
  });

  it('renames displayName only, never userPrincipalName', async () => {
    // Renaming the UPN breaks mailbox resolution and muddies the audit trail; the runbook says
    // change the name, not the sign-in address.
    const { g, calls } = clientDouble();
    await setDisplayName(g, 'u-1', 'ZZ_Inactive_Doe_Jane_2026-09-02');
    expect(calls[0].body).toEqual({ displayName: 'ZZ_Inactive_Doe_Jane_2026-09-02' });
    expect(JSON.stringify(calls[0].body)).not.toContain('userPrincipalName');
  });

  it('removes every named license in a single assignLicense call', async () => {
    const { g, calls } = clientDouble();
    await removeLicenses(g, 'u-1', ['sku-a', 'sku-b']);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/users/u-1/assignLicense',
      body: { addLicenses: [], removeLicenses: ['sku-a', 'sku-b'] },
    });
  });

  it('does not call Graph at all when there are no licenses to reclaim', async () => {
    const { g, calls } = clientDouble();
    await removeLicenses(g, 'u-1', []);
    expect(calls).toEqual([]);
  });

  it('removes a group membership via the $ref endpoint', async () => {
    const { g, calls } = clientDouble();
    await removeFromGroup(g, 'g-1', 'u-1');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/groups/g-1/members/u-1/$ref' });
  });
});

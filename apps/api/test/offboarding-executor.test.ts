import { describe, it, expect, vi } from 'vitest';
import { executeOffboardPlan, type OffboardOps } from '../src/modules/offboarding/executor.js';
import { planOffboard, type OffboardPlanInput } from '../src/modules/offboarding/planner.js';

// The executor is pure-with-injected-ops: no Graph imports, no DB imports. Everything it touches
// arrives through OffboardOps, which is what makes these assertions about real behaviour rather
// than about mocks.
const opsDouble = () => {
  const order: string[] = [];
  const recorded: Array<[string, string]> = [];
  const ops: OffboardOps = {
    blockSignin: vi.fn(async () => { order.push('blockSignin'); }),
    revokeSessions: vi.fn(async () => { order.push('revokeSessions'); }),
    rename: vi.fn(async () => { order.push('rename'); }),
    removeLicenses: vi.fn(async () => { order.push('removeLicenses'); }),
    removeFromGroups: vi.fn(async () => { order.push('removeFromGroups'); }),
    recordStep: vi.fn(async (key: string, status: string) => { recorded.push([key, status]); }),
  };
  return { ops, order, recorded };
};

const input = (over: Partial<OffboardPlanInput> = {}): OffboardPlanInput => ({
  answers: { last_day: '2026-09-02' },
  departingUpn: 'jane.doe@sbsfederal.com',
  user: {
    id: 'u-1', userPrincipalName: 'jane.doe@sbsfederal.com', displayName: 'Jane Doe',
    accountEnabled: true, givenName: 'Jane', surname: 'Doe',
  },
  directoryRoleCount: 0, licenseSkuIds: ['sku-e3'], groupIds: ['g-1'], mailboxType: 'user',
  ...over,
});

describe('executeOffboardPlan', () => {
  it('runs the automated steps in plan order', async () => {
    const { ops, order } = opsDouble();
    await executeOffboardPlan(planOffboard(input()), 'u-1', ops);
    expect(order).toEqual(['blockSignin', 'revokeSessions', 'rename']);
  });

  it('halts at the manual mailbox step instead of stripping licenses behind it', async () => {
    // The whole point of the ordering rule: an unlicensed mailbox cannot be converted to shared.
    // Continuing past an unconfirmed conversion would destroy what the runbook preserves.
    const { ops, order } = opsDouble();
    const outcomes = await executeOffboardPlan(planOffboard(input()), 'u-1', ops);
    expect(order).not.toContain('removeLicenses');
    expect(outcomes.find((o) => o.key === 'convert_shared_mailbox')?.status).toBe('awaiting_manual');
  });

  it('runs through to the end when there is no mailbox to convert', async () => {
    const { ops, order } = opsDouble();
    await executeOffboardPlan(planOffboard(input({ mailboxType: 'none' })), 'u-1', ops);
    expect(order).toEqual(['blockSignin', 'revokeSessions', 'rename', 'removeLicenses', 'removeFromGroups']);
  });

  it('refuses a plan carrying blockers before performing any operation', async () => {
    const { ops, order } = opsDouble();
    const blocked = { ...planOffboard(input()), blockers: [{ code: 'legal_hold', message: 'held' }] };
    await expect(executeOffboardPlan(blocked, 'u-1', ops)).rejects.toThrow(/blocker/i);
    expect(order).toEqual([]);
  });

  it('refuses a plan whose steps are out of order rather than trusting the caller', async () => {
    const { ops, order } = opsDouble();
    const p = planOffboard(input());
    await expect(executeOffboardPlan({ ...p, steps: [...p.steps].reverse() }, 'u-1', ops))
      .rejects.toThrow(/order/i);
    expect(order).toEqual([]);
  });

  it('runs only the security steps when asked, for the scheduled-drift case', async () => {
    // The inversion: on plan drift the account must still be made safe, but nothing that
    // destroys data may proceed on a plan nobody approved.
    const { ops, order } = opsDouble();
    const outcomes = await executeOffboardPlan(planOffboard(input()), 'u-1', ops, { onlySecuritySteps: true });
    expect(order).toEqual(['blockSignin', 'revokeSessions']);
    expect(outcomes.find((o) => o.key === 'rename_account')?.status).toBe('skipped');
    expect(outcomes.find((o) => o.key === 'remove_licenses')?.status).toBe('skipped');
  });

  it('records every step it performs, so evidence survives a later failure', async () => {
    const { ops, recorded } = opsDouble();
    await executeOffboardPlan(planOffboard(input()), 'u-1', ops);
    expect(recorded).toContainEqual(['block_signin', 'succeeded']);
    expect(recorded).toContainEqual(['revoke_sessions', 'succeeded']);
  });

  it('stops at the first failure and records it, rather than continuing blind', async () => {
    const { ops, order, recorded } = opsDouble();
    (ops.revokeSessions as any).mockRejectedValueOnce(new Error('graph 503'));
    const outcomes = await executeOffboardPlan(planOffboard(input()), 'u-1', ops);
    expect(order).toEqual(['blockSignin']);
    expect(recorded).toContainEqual(['revoke_sessions', 'failed']);
    expect(outcomes.find((o) => o.key === 'revoke_sessions')?.error).toMatch(/503/);
    // rename must not have been attempted after a failed revoke
    expect(outcomes.find((o) => o.key === 'rename_account')).toBeUndefined();
  });
});

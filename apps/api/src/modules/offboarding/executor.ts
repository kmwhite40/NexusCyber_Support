// Pure-with-injected-ops execution for offboarding.
//
// No Graph imports, no DB imports. Everything this file touches arrives through OffboardOps,
// which is what keeps the ordering and refusal logic testable without a tenant or a database —
// the same arrangement as modules/provisioning/executor.ts.
//
// Spec: docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md
import { OFFBOARD_STEP_ORDER, type OffboardPlan, type OffboardStepKey } from './planner.js';

export interface OffboardOps {
  blockSignin(userId: string): Promise<void>;
  revokeSessions(userId: string): Promise<void>;
  rename(userId: string, displayName: string): Promise<void>;
  removeLicenses(userId: string, skuIds: string[]): Promise<void>;
  removeFromGroups(userId: string, groupIds: string[]): Promise<void>;
  recordStep(
    key: string,
    status: 'succeeded' | 'failed' | 'awaiting_manual',
    detail: Record<string, unknown>,
  ): Promise<void>;
}

export interface OffboardOutcome { key: string; status: string; error?: string }

/**
 * Steps that make the account SAFE. They destroy no data, which is why they still run when the
 * plan has drifted since approval — see jobs/offboarding-sweeper.ts for that inversion.
 */
const SECURITY_STEPS: OffboardStepKey[] = ['block_signin', 'revoke_sessions'];

export async function executeOffboardPlan(
  plan: OffboardPlan,
  userId: string,
  ops: OffboardOps,
  opts: { onlySecuritySteps?: boolean } = {},
): Promise<OffboardOutcome[]> {
  // Blockers refuse a FULL run — but never the security-only path.
  //
  // The security steps destroy no data, and the situation that produces a blocker at fire time
  // (someone edited last_day, a licence pool moved) is emphatically not a reason to leave a
  // terminated employee signed in. Refusing here inverted the very priority this engine exists
  // to enforce: it made a stale form field sufficient to keep an account enabled.
  if (plan.blockers.length > 0 && !opts.onlySecuritySteps) {
    throw new Error(`refusing to execute: plan carries ${plan.blockers.length} blocker(s)`);
  }

  // Re-verify the order even though our own planner built it. This is THE constraint protecting
  // the mailbox, it is cheap to check, and "the planner would never do that" is exactly the
  // assumption that stops being true when someone adds a second caller.
  const got = plan.steps.map((s) => s.key);
  const expected = OFFBOARD_STEP_ORDER.filter((k) => got.includes(k));
  if (got.join(',') !== expected.join(',')) {
    throw new Error(`refusing to execute: steps are out of order (${got.join(' -> ')})`);
  }

  const outcomes: OffboardOutcome[] = [];
  for (const step of plan.steps) {
    if (opts.onlySecuritySteps && !SECURITY_STEPS.includes(step.key)) {
      outcomes.push({ key: step.key, status: 'skipped' });
      continue;
    }

    // A manual step STOPS the run here rather than being skipped over. Everything after it
    // depends on it having happened: removing licenses before the mailbox is converted destroys
    // the mailbox the conversion exists to preserve.
    if (step.manual) {
      await ops.recordStep(step.key, 'awaiting_manual', step.detail);
      outcomes.push({ key: step.key, status: 'awaiting_manual' });
      break;
    }

    try {
      switch (step.key) {
        case 'block_signin':
          await ops.blockSignin(userId); break;
        case 'revoke_sessions':
          await ops.revokeSessions(userId); break;
        case 'rename_account':
          await ops.rename(userId, plan.inactiveName); break;
        case 'remove_licenses':
          await ops.removeLicenses(userId, (step.detail.skuIds as string[]) ?? []); break;
        case 'remove_groups_dls_roles':
          await ops.removeFromGroups(userId, (step.detail.groupIds as string[]) ?? []); break;
      }
      await ops.recordStep(step.key, 'succeeded', step.detail);
      outcomes.push({ key: step.key, status: 'succeeded' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'step failed';
      await ops.recordStep(step.key, 'failed', { ...step.detail, error: message });
      outcomes.push({ key: step.key, status: 'failed', error: message });
      // Stop on the first failure. Every later step assumes the earlier ones happened — a rename
      // after a failed revoke would leave an account renamed but still serving live sessions.
      break;
    }
  }
  return outcomes;
}

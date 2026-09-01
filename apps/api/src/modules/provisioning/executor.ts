// Walks a Plan with side effects enabled. Every step is idempotent so a retry after a partial
// run (e.g. a network timeout whose write actually landed server-side) adopts what already
// exists instead of duplicating it. Graph access is injected via ProvisioningOps so the whole
// engine is testable with no network — this file must never import the Graph client directly.
//
// This is the highest-stakes code in the provisioning feature: every step performs an
// irreversible write against a live GCC High tenant. Two invariants exist specifically to bound
// that risk and must not be weakened:
//   1. A plan carrying any blocker is refused before a single ops.* call is made (see the guard
//      at the top of executePlan) — this is the last line of defence behind the admin's
//      dry-run approval.
//   2. The loop returns immediately on the first step failure. It never attempts to run a later
//      step once an earlier one has thrown, because later steps (licensing, group membership,
//      Cloud PC assignment) assume every prior step actually succeeded.
import type { Plan, StepKey } from './planner.js';
import { randomBytes } from 'node:crypto';

export interface StepOutcome {
  key: StepKey;
  status: 'succeeded' | 'failed' | 'skipped';
  graphObjectId?: string;
  error?: string;
}

export interface ProvisioningOps {
  findUser: (upn: string) => Promise<{ id: string; userPrincipalName: string } | null>;
  createUser: (body: Record<string, unknown>) => Promise<{ id: string }>;
  currentLicenses: (userId: string) => Promise<string[]>;
  assignLicenses: (userId: string, skuIds: string[]) => Promise<unknown>;
  addToGroup: (groupId: string, userId: string) => Promise<unknown>;
  issueTap: (userId: string) => Promise<{ temporaryAccessPass: string }>;
  deliverTap: (supervisorId: string, upn: string, pass: string) => Promise<void>;
}

export async function executePlan(
  plan: Plan,
  ops: ProvisioningOps,
): Promise<{ outcomes: StepOutcome[]; status: 'succeeded' | 'failed' | 'awaiting_cloudpc' }> {
  // Refuse BEFORE any side effect. This must stay the very first thing executePlan does: it is
  // the backstop that guarantees what the admin approved in the dry-run preview (a plan with
  // zero blockers) is the only shape of plan this function will ever act on.
  if (plan.blockers.length > 0) {
    throw new Error(`refusing to execute: plan has ${plan.blockers.length} blocker(s)`);
  }

  const outcomes: StepOutcome[] = [];
  let userId = '';
  let awaiting = false;

  for (const step of plan.steps) {
    try {
      switch (step.key) {
        case 'create_user': {
          // Idempotent adoption: look the UPN up first. A retry after a timeout whose write
          // actually succeeded server-side must adopt the object Graph already created, never
          // call createUser a second time and mint a duplicate identity.
          const existing = await ops.findUser(plan.upn);
          if (existing) {
            userId = existing.id;
          } else {
            const created = await ops.createUser({
              accountEnabled: true,
              displayName: plan.displayName,
              userPrincipalName: plan.upn,
              mailNickname: plan.upn.split('@')[0],
              passwordProfile: {
                forceChangePasswordNextSignIn: true,
                // Never read back: assigned to Graph and immediately discarded. See
                // generateInitialPassword() below for why this exists and why it is safe to
                // throw away.
                password: generateInitialPassword(),
              },
            });
            userId = created.id;
          }
          outcomes.push({ key: step.key, status: 'succeeded', graphObjectId: userId });
          break;
        }
        case 'assign_licenses': {
          const want = (step.detail.skuIds as string[] | undefined) ?? [];
          const have = await ops.currentLicenses(userId);
          const missing = want.filter((s) => !have.includes(s)); // assign only the delta
          if (missing.length) await ops.assignLicenses(userId, missing);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'add_groups': {
          // Seam: the planner (Task 11) only ever knows group NAMES (detail.groups) because it
          // is a pure function with no directory access. Task 15's service layer resolves those
          // names to ids and writes detail.groupIds before calling executePlan. Read groupIds
          // here — do not resolve names in this file; that would require I/O and break the
          // preview/execute purity guarantee the planner depends on.
          const groupIds = (step.detail.groupIds as string[] | undefined) ?? [];
          for (const groupId of groupIds) await ops.addToGroup(groupId, userId);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'assign_cloudpc': {
          await ops.addToGroup(step.detail.groupId as string, userId);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'issue_tap': {
          const tap = await ops.issueTap(userId);
          await ops.deliverTap(String(step.detail.supervisor ?? ''), plan.upn, tap.temporaryAccessPass);
          // The TAP value (tap.temporaryAccessPass) is a live credential. It is used exactly
          // once, above, to hand it to deliverTap, and then goes out of scope. It must never be
          // placed on the outcome — not as graphObjectId, not as error text, not anywhere — since
          // outcomes are the kind of structure that ends up in a ticket worklog or an audit
          // detail blob. Do not add a field here without checking this comment.
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'await_cloudpc': {
          // Reaching this step is a *success-shaped resting state*, not a failure: the executor
          // has done everything it can synchronously, and a separate poller (outside this file)
          // takes over to watch for the Cloud PC finishing its build.
          awaiting = true;
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        default: {
          // Exhaustiveness guard: StepKey is a closed union, so this branch is unreachable for
          // any key the planner can currently emit. It exists as a compile-time and run-time
          // trip-wire if StepKey ever grows a case this executor hasn't been taught to handle —
          // failing loudly here is much safer than silently skipping an irreversible step.
          const exhaustive: never = step.key;
          throw new Error(`unhandled provisioning step: ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      outcomes.push({ key: step.key, status: 'failed', error: toErrorMessage(err) });
      return { outcomes, status: 'failed' }; // stop at the first failure — never run later steps
    }
  }

  return { outcomes, status: awaiting ? 'awaiting_cloudpc' : 'succeeded' };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A throwaway initial password for the Entra passwordProfile on account creation.
 *
 * The account never actually signs in with this value: onboarding hands the user a Temporary
 * Access Pass (see the issue_tap step) instead, and forceChangePasswordNextSignIn means this
 * password is invalidated the moment it would otherwise be used. Even so, from the instant
 * createUser succeeds until that first sign-in, it IS a real, live credential on a real federal
 * (GCC High) identity — so it is generated with cryptographically strong randomness via Node's
 * crypto module (32 bytes = 256 bits of entropy), not a predictable or low-entropy scheme, and a
 * fixed complexity-class suffix guarantees it satisfies Entra's upper/lower/digit/symbol policy
 * regardless of what the random bytes happen to contain.
 *
 * This value is used exactly once, inline, to build the createUser request body, and is never
 * logged, never returned from executePlan (StepOutcome has no field for it), and never persisted
 * anywhere by this module.
 */
function generateInitialPassword(): string {
  const random = randomBytes(32).toString('base64url'); // 256 bits; URL-safe alphabet only
  return `${random}Aa1!`;
}

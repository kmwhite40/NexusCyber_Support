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

/**
 * Spec open item #4's fallback, made representable.
 *
 * The tenant either has the Temporary Access Pass authentication method enabled or it does not,
 * and that is a TENANT CONFIGURATION fact, not a failure of this run. The spec's ruling is that
 * `issue_tap` is then marked `skipped` and the rest of the run is unaffected — anything else
 * fails the run AFTER the account, the licences and the group memberships are already written,
 * which leaves a live federal identity behind and reports it as a failure.
 *
 * The TYPE lives here, in the executor, and the Graph classification that raises it lives in the
 * service layer's ops adapter: this file must never import the Graph client, and the executor
 * must never learn to read a Graph error body. An ops implementation says "this specific tenant
 * state" by throwing this; every other error keeps failing the run exactly as before.
 */
export class TapPolicyUnavailableError extends Error {
  constructor(message = 'the tenant has no Temporary Access Pass policy enabled') {
    super(message);
    this.name = 'TapPolicyUnavailableError';
  }
}

/**
 * The text recorded on the SKIPPED `issue_tap` step, and echoed into the ticket note.
 *
 * Written to be unmistakable in a list of green ticks: a run that reaches this point SUCCEEDED
 * at creating a live account that NOBODY CAN SIGN INTO until an administrator sets its first
 * credential by hand. "skipped" alone does not say that.
 */
export const TAP_SKIPPED_NOTICE =
  'NO CREDENTIAL WAS DELIVERED — the Temporary Access Pass method is not enabled in the tenant. '
  + 'An administrator must set this account\'s first sign-in credential out of band.';

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
            const password = generateInitialPassword();
            let created: { id: string };
            try {
              created = await ops.createUser({
                accountEnabled: true,
                displayName: plan.displayName,
                userPrincipalName: plan.upn,
                mailNickname: plan.upn.split('@')[0],
                passwordProfile: {
                  forceChangePasswordNextSignIn: true,
                  // Never read back: assigned to Graph and immediately discarded. See
                  // generateInitialPassword() below for why this exists and why it is safe to
                  // throw away.
                  password,
                },
              });
            } catch (err) {
              // createUser adapters (especially validation-rejection paths) commonly echo the
              // request body — including this password — back in their error text. Redact it
              // using the value we hold in scope before it can reach the outer catch and land in
              // a StepOutcome. See redactSecret() for why this is done here, locally, rather than
              // by pattern-matching "known sensitive fields" somewhere central.
              throw new Error(redactSecret(toErrorMessage(err), password));
            }
            userId = created.id;
          }
          outcomes.push({ key: step.key, status: 'succeeded', graphObjectId: userId });
          break;
        }
        case 'assign_licenses': {
          requireUserId(userId, step.key);
          const want = (step.detail.skuIds as string[] | undefined) ?? [];
          const have = await ops.currentLicenses(userId);
          const missing = want.filter((s) => !have.includes(s)); // assign only the delta
          if (missing.length) await ops.assignLicenses(userId, missing);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'add_groups': {
          requireUserId(userId, step.key);
          // Seam: the planner (Task 11) only ever knows group NAMES (detail.groups) because it
          // is a pure function with no directory access. Task 15's service layer resolves those
          // names to ids and writes detail.groupIds before calling executePlan. Read groupIds
          // here — do not resolve names in this file; that would require I/O and break the
          // preview/execute purity guarantee the planner depends on.
          const groupNames = (step.detail.groups as string[] | undefined) ?? [];
          const groupIds = (step.detail.groupIds as string[] | undefined) ?? [];
          // The planner (planner.ts) only ever emits an add_groups step when it has group
          // names to add, so an add_groups step with names present but no ids means Task 15's
          // resolution pass did not run (or silently produced nothing). Failing loudly here
          // beats reporting "succeeded" while the user quietly never gets the access.
          if (groupNames.length > 0 && groupIds.length === 0) {
            throw new Error(
              `add_groups: detail.groupIds is empty but detail.groups has ${groupNames.length} name(s) ` +
                '— group id resolution did not run; refusing to silently skip group membership.',
            );
          }
          for (const groupId of groupIds) await ops.addToGroup(groupId, userId);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'assign_cloudpc': {
          requireUserId(userId, step.key);
          const groupId = step.detail.groupId;
          if (typeof groupId !== 'string' || groupId.length === 0) {
            throw new Error('assign_cloudpc: detail.groupId is missing or not a non-empty string');
          }
          await ops.addToGroup(groupId, userId);
          outcomes.push({ key: step.key, status: 'succeeded' });
          break;
        }
        case 'issue_tap': {
          requireUserId(userId, step.key);
          // The planner already read the tenant's TAP policy (readTenantState) and marked this
          // step when it is off. Honour that WITHOUT calling Graph: the whole point of the
          // up-front read is to stop depending on regex-matching an error whose exact wording in
          // this cloud is unverified. The catch below stays as the backstop for the case the
          // planner could not determine — an unreadable policy, or a tenant that changed since.
          if (step.detail.willSkip === true) {
            outcomes.push({
              key: step.key,
              status: 'skipped',
              error: String(step.detail.skipReason ?? TAP_SKIPPED_NOTICE),
            });
            break;
          }
          let pass: string | undefined;
          try {
            const tap = await ops.issueTap(userId);
            pass = tap.temporaryAccessPass;
            await ops.deliverTap(String(step.detail.supervisor ?? ''), plan.upn, pass);
          } catch (err) {
            // Spec open item #4: a tenant with no TAP policy is a configuration fact, not a run
            // failure. Skip the step, keep going, and say loudly on the outcome that no
            // credential was delivered. Checked BEFORE the redact/rethrow below because this is
            // the one error here that must not become a failure — and it can only be raised
            // before a pass exists, so there is nothing to redact.
            if (err instanceof TapPolicyUnavailableError) {
              outcomes.push({ key: step.key, status: 'skipped', error: TAP_SKIPPED_NOTICE });
              break;
            }
            // Same rationale as create_user above: issueTap/deliverTap adapters (HTTP, SMTP,
            // ...) commonly echo request content — including the TAP itself — into thrown error
            // messages. Redact using the value this step actually holds before it can propagate.
            throw new Error(redactSecret(toErrorMessage(err), pass));
          }
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
 * Guards every step that depends on a directory object id having already been established by
 * create_user. If a plan is ever malformed (missing create_user, or reordered ahead of it),
 * `userId` is still `''` here — without this guard that empty string would reach
 * `ops.currentLicenses('')` / `ops.addToGroup(g, '')` / `ops.issueTap('')` and be sent to a live
 * tenant. Graph would likely reject an empty subject, but this file should fail locally, before
 * the network call, rather than rely on the far side of a real GCC High API to catch its own bug.
 */
function requireUserId(userId: string, stepKey: StepKey): void {
  if (!userId) {
    throw new Error(`${stepKey}: no user id available — a prior create_user step must run and succeed first`);
  }
}

/**
 * Strips a known secret value out of an error message before it is allowed to reach a
 * StepOutcome (and from there, potentially a ticket worklog or audit detail blob).
 *
 * Deliberately NOT implemented as a central deny-list of "sensitive step keys" or a regex over
 * known secret *shapes*: adapters (HTTP clients, SMTP libraries, Graph SDKs) commonly echo
 * request payloads back into thrown error text, and there is no reliable way to enumerate every
 * shape that could take. Instead, each step that generates or receives a secret redacts using the
 * literal value it already holds in scope at the moment it catches an error — see the try/catch
 * around createUser (secret: the generated password) and around issueTap/deliverTap (secret: the
 * TAP). This pattern generalizes cleanly: a future step that introduces a new secret must catch
 * its own errors and redact with the value it holds, the same way — there is no separate list
 * anywhere else that a reviewer could forget to update, because the redaction lives right next to
 * the code that received the secret in the first place.
 */
function redactSecret(message: string, secret: string | undefined): string {
  if (!secret) return message;
  return message.split(secret).join('[redacted]');
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

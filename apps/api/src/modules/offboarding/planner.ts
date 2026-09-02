// Pure planning for offboarding. No I/O — the service layer reads tenant state and hands it in,
// exactly as modules/provisioning/planner.ts does for the other direction.
//
// This module deliberately does NOT import from modules/provisioning. The two engines share the
// run tables and the discipline (plan, fingerprint, human approval, per-step evidence) but never
// a planning path: onboarding creates, offboarding destroys, and a bug in the destructive half
// must not be able to reach the half that provisions live federal identities.
//
// Spec: docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md

import { createHash } from 'node:crypto';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The disabled-account naming convention: `ZZ_Inactive_<Last>_<First>_<YYYY-MM-DD>`.
 *
 * `ZZ_` sorts departed accounts to the bottom of every admin list. The embedded date is the
 * LAST DAY, not the day the rename ran, which makes the 1yr/7yr retention clock readable
 * straight off the account without a lookup — the reason the format is load-bearing rather than
 * cosmetic.
 *
 * Underscore is the segment separator, so it is stripped from the name parts along with
 * whitespace; otherwise "Van Der Berg" yields a name nobody can parse back apart. Hyphens are
 * kept: "Anne-Marie" is one segment and reads correctly.
 *
 * Throws on a non-ISO last day rather than embedding junk. A malformed date here would silently
 * make the retention clock unreadable on exactly the accounts that must be retained longest.
 */
export function inactiveDisplayName(last: string, first: string, lastDay: string): string {
  if (!ISO_DATE.test(lastDay)) {
    throw new Error(`last day must be an ISO date (YYYY-MM-DD), got "${lastDay}"`);
  }
  const clean = (s: string) => s.replace(/[\s_]+/g, '').trim();
  return `ZZ_Inactive_${clean(last)}_${clean(first)}_${lastDay}`;
}

export type OffboardStepKey =
  | 'block_signin' | 'revoke_sessions' | 'rename_account'
  | 'convert_shared_mailbox' | 'remove_licenses' | 'remove_groups_dls_roles';

export interface OffboardStep {
  key: OffboardStepKey;
  label: string;
  /** True when no API can perform this — a human must do it and confirm. See the mailbox step. */
  manual: boolean;
  detail: Record<string, unknown>;
}
export interface Blocker { code: string; message: string }

export interface OffboardPlan {
  upn: string;
  currentDisplayName: string;
  inactiveName: string;
  privileged: boolean;
  steps: OffboardStep[];
  blockers: Blocker[];
}

export interface OffboardPlanInput {
  answers: Record<string, unknown>;
  user: { id: string; userPrincipalName: string; displayName: string; accountEnabled: boolean } | null;
  directoryRoleCount: number;
  licenseSkuIds: string[];
  groupIds: string[];
  mailboxType: 'user' | 'shared' | 'none';
}

/**
 * THE ORDERING CONSTRAINT, in one place, because it is the whole reason this planner exists.
 *
 * `convert_shared_mailbox` MUST precede `remove_licenses`: a mailbox can only be converted to
 * shared while it is still licensed. Strip the licence first and the mailbox drops into
 * soft-delete and the conversion fails — destroying the very artifact the runbook was trying to
 * preserve.
 *
 * `revoke_sessions` MUST follow `block_signin`: revoking first leaves a window in which a live
 * session mints fresh tokens against an account that is still enabled.
 */
export const OFFBOARD_STEP_ORDER: OffboardStepKey[] = [
  'block_signin', 'revoke_sessions', 'rename_account',
  'convert_shared_mailbox', 'remove_licenses', 'remove_groups_dls_roles',
];

const ALREADY_OFFBOARDED_PREFIX = 'ZZ_Inactive_';

export function planOffboard(input: OffboardPlanInput): OffboardPlan {
  const blockers: Blocker[] = [];
  const first = String(input.answers.legal_first_name ?? '');
  const last = String(input.answers.legal_last_name ?? '');
  const lastDay = String(input.answers.last_day ?? '');

  // Any directory role at all makes this a privileged account, which is what selects the 7-year
  // retention path in phase 2 rather than the 1-year default.
  const privileged = input.directoryRoleCount > 0;

  let inactiveName = '';
  try {
    inactiveName = inactiveDisplayName(last, first, lastDay);
  } catch (e) {
    // Reported, never thrown: a planner that throws gives the admin a stack trace instead of a
    // readable reason, and the other blockers below would never be collected.
    blockers.push({ code: 'bad_last_day', message: (e as Error).message });
  }

  if (!input.user) {
    blockers.push({ code: 'user_not_found', message: 'The account was not found in the tenant.' });
  } else if (!input.user.accountEnabled && input.user.displayName.startsWith(ALREADY_OFFBOARDED_PREFIX)) {
    // Disabled AND renamed means a previous run finished. Disabled alone is a normal pre-state
    // — HR often disables early — and must still be completable.
    blockers.push({
      code: 'already_offboarded',
      message: `${input.user.userPrincipalName} is already disabled and renamed; refusing to re-run.`,
    });
  }

  if (input.answers.legal_hold === true) {
    blockers.push({
      code: 'legal_hold',
      message: 'Legal hold is set: this plan would convert the mailbox and reclaim licenses.',
    });
  }

  // Only emit a conversion when there is a user mailbox to preserve. A shared or absent mailbox
  // has nothing to convert, and emitting a manual step nobody can complete would stall the run
  // at that step forever — the executor halts there by design.
  const wantsConversion = input.mailboxType === 'user';

  const all: Record<OffboardStepKey, OffboardStep> = {
    block_signin: {
      key: 'block_signin', label: 'Block sign-in', manual: false,
      detail: { userId: input.user?.id },
    },
    revoke_sessions: {
      key: 'revoke_sessions', label: 'Revoke sessions and refresh tokens', manual: false,
      detail: { userId: input.user?.id },
    },
    rename_account: {
      key: 'rename_account', label: `Rename to ${inactiveName}`, manual: false,
      detail: { userId: input.user?.id, displayName: inactiveName },
    },
    convert_shared_mailbox: {
      key: 'convert_shared_mailbox',
      label: 'Convert mailbox to shared (manual — Exchange Online PowerShell)',
      manual: true,
      detail: { upn: input.user?.userPrincipalName },
    },
    remove_licenses: {
      key: 'remove_licenses', label: `Reclaim ${input.licenseSkuIds.length} license(s)`, manual: false,
      detail: { skuIds: input.licenseSkuIds },
    },
    remove_groups_dls_roles: {
      key: 'remove_groups_dls_roles',
      label: `Remove ${input.groupIds.length} group/DL membership(s) and directory roles`,
      manual: false,
      detail: { groupIds: input.groupIds, directoryRoleCount: input.directoryRoleCount },
    },
  };

  // Built by filtering the canonical order, never by pushing in ad-hoc sequence: the order is
  // the safety property, so there is exactly one place it is expressed.
  const steps = OFFBOARD_STEP_ORDER
    .filter((k) => (k === 'convert_shared_mailbox' ? wantsConversion : true))
    .map((k) => all[k]);

  return {
    upn: input.user?.userPrincipalName ?? '',
    currentDisplayName: input.user?.displayName ?? '',
    inactiveName,
    privileged,
    steps,
    blockers,
  };
}

/**
 * Binds an approved plan to the exact set of writes it authorises.
 *
 * Covers the step DETAIL, not just the keys: "reclaim 1 licence" and "reclaim 4 licences" are
 * the same six steps and very different acts, and the admin approved one of them.
 *
 * What the service does with a mismatch differs by direction, and the difference is deliberate.
 * Onboarding refuses the whole run — creating the wrong account is worse than creating nothing.
 * Offboarding still blocks sign-in and revokes sessions, because failing to disable a terminated
 * employee is the dangerous outcome; only the data-affecting steps halt. See
 * jobs/offboarding-sweeper.ts.
 */
export function offboardFingerprint(plan: OffboardPlan): string {
  const material = JSON.stringify({
    upn: plan.upn,
    inactiveName: plan.inactiveName,
    privileged: plan.privileged,
    steps: plan.steps.map((s) => [s.key, s.manual, s.detail]),
  });
  return createHash('sha256').update(material).digest('hex');
}

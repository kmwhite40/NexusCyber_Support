// Pure planning for offboarding. No I/O — the service layer reads tenant state and hands it in,
// exactly as modules/provisioning/planner.ts does for the other direction.
//
// This module deliberately does NOT import from modules/provisioning. The two engines share the
// run tables and the discipline (plan, fingerprint, human approval, per-step evidence) but never
// a planning path: onboarding creates, offboarding destroys, and a bug in the destructive half
// must not be able to reach the half that provisions live federal identities.
//
// Spec: docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md

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

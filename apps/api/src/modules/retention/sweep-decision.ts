/**
 * What to do about one retention hold. Pure, so every branch is testable without a tenant.
 *
 * THE CASE THAT MATTERS MOST is `accountPresent === null`, meaning the check did not complete —
 * a throttle, an outage, a permissions problem. It returns 'none', NOT 'touch', because stamping
 * last_checked_at on an unsuccessful check records a tenant outage as "account confirmed
 * present". That is precisely the reading that would let a real breach pass unnoticed, and it
 * would do so while making the sweeper look healthy.
 *
 * Spec: docs/superpowers/specs/2026-09-02-offboarding-retention-holds-design.md
 */
export type HoldOutcome =
  | { action: 'none' }
  | { action: 'touch' }
  | { action: 'breach' }
  | { action: 'eligible' }
  | { action: 'disposed' };

export function decideHold(
  hold: { retain_until: string | Date },   // pg returns timestamptz as a Date
  accountPresent: boolean | null,          // null = could not check
  now: Date,
): HoldOutcome {
  if (accountPresent === null) return { action: 'none' };

  const expired = now.getTime() >= new Date(hold.retain_until).getTime();

  if (accountPresent) {
    // Still there: either we are inside the obligation (fine) or it has ended (time to review).
    return expired ? { action: 'eligible' } : { action: 'touch' };
  }
  // Gone: before the date that is a compliance breach; after it, someone did the right thing.
  return expired ? { action: 'disposed' } : { action: 'breach' };
}

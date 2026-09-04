// Ordering for the ticket status action row.
//
// The row re-renders in place after every transition, so a button's POSITION is not stable while
// its meaning changes. From in_progress the row is [waiting customer] [resolved]; clicking
// resolved re-renders it to [closed] [reopened] — putting the action that UNDOES the resolve
// exactly where the resolve button just was. A second click, or one already in flight, silently
// un-resolves the ticket, and the operator sees "in progress" on work they finished.
//
// This was reported three times as "resolved tickets still say in progress" and looked like user
// error in the event log, because every transition is genuinely attributed to the operator.

/** Transitions that undo completed work rather than advancing it. */
export const REVERSING_STATES = new Set(['reopened']);

/**
 * Reversing actions FIRST, forward actions after.
 *
 * Counter-intuitive until you look at where the hand is. The primary action is the LAST button in
 * its row — from in_progress the row is [waiting customer] [resolved], and the operator clicks the
 * rightmost one. So the dangerous slot is the last one, and putting the reversing action there is
 * precisely what turned a resolve into a reopen. Leading with it means a stray second click lands
 * on `closed` instead: still a forward action, and the one someone resolving a ticket most likely
 * wants next.
 *
 * Ordering alone cannot make this safe — the row genuinely must re-render to show only legal
 * transitions — so it is paired with a short guard after each change. This is the cheaper half of
 * the defence, not the whole of it.
 */
export function orderTransitions(states: string[]): string[] {
  return [...states].sort((a, b) => {
    const ra = REVERSING_STATES.has(a) ? 0 : 1;
    const rb = REVERSING_STATES.has(b) ? 0 : 1;
    return ra - rb;
  });
}

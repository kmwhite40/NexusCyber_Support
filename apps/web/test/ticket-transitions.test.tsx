import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { orderTransitions, REVERSING_STATES } from '@/lib/ticket-actions';

// Reported three times: "tickets still say in progress when I resolved them." The event log shows
// resolved -> reopened -> in_progress within 1-2 seconds, attributed to the operator — which for a
// long time read as user error. It is not.
//
// The action row re-renders in place. From in_progress the buttons are [waiting customer]
// [resolved]; clicking resolved re-renders the row to [closed] [reopened], putting REOPENED
// exactly where RESOLVED just was. A second click, or one already in flight, un-resolves the
// ticket. From reopened the row becomes [in progress] in first position, and a third click lands
// there. The control changes meaning under the cursor.
describe('transition action ordering', () => {
  it('never puts a reversing action where the previous primary action sat', () => {
    // Resolving is the last button from in_progress; reopen must not take that slot.
    const fromInProgress = orderTransitions(['waiting_customer', 'resolved']);
    const fromResolved = orderTransitions(['closed', 'reopened']);
    expect(fromInProgress[fromInProgress.length - 1]).toBe('resolved');
    expect(fromResolved[fromResolved.length - 1]).not.toBe('reopened');
  });

  // Reversing first, because the LAST slot is the one the hand is already aimed at: the primary
  // action ([waiting customer] [resolved]) is rightmost. A stray second click should land on a
  // forward action, not on the one that undoes the work just finished.
  it('leads with the reversing action so the dangerous slot holds a forward one', () => {
    expect(orderTransitions(['closed', 'reopened'])).toEqual(['reopened', 'closed']);
  });

  it('knows which states undo work', () => {
    expect(REVERSING_STATES.has('reopened')).toBe(true);
    expect(REVERSING_STATES.has('resolved')).toBe(false);
  });

  it('leaves a single-option row alone', () => {
    expect(orderTransitions(['in_progress'])).toEqual(['in_progress']);
  });
});

// Carbon's §6 names this the hard requirement: "A ticket must be reopenable, repeatedly."
// A ticket closing in Anchor does not close the finding in Carbon — Carbon closes it only on
// re-collected evidence. If reassessment still fails, Carbon reopens. If Anchor refuses, Carbon
// must mint a NEW ticket every cycle, which destroys the remediation history on exactly the
// item whose history matters most.
import { describe, it, expect } from 'vitest';
import { DEFAULT_TRANSITIONS, isTransitionAllowed } from '../src/modules/workflows.js';

describe('reopening a closed ticket', () => {
  it('allows closed -> reopened in the built-in map', () => {
    expect(isTransitionAllowed(DEFAULT_TRANSITIONS, 'closed', 'reopened')).toBe(true);
  });

  it('supports the full remediation cycle, repeatedly', () => {
    // in_progress -> resolved -> closed -> reopened -> in_progress, and round again. Every hop
    // must be legal or Carbon cannot drive a finding that keeps failing reassessment.
    const cycle = [
      ['in_progress', 'resolved'],
      ['resolved', 'closed'],
      ['closed', 'reopened'],
      ['reopened', 'in_progress'],
    ] as const;
    for (const [from, to] of [...cycle, ...cycle]) {
      expect([from, to, isTransitionAllowed(DEFAULT_TRANSITIONS, from, to)]).toEqual([from, to, true]);
    }
  });

  it('keeps resolved -> reopened working, which already did', () => {
    expect(isTransitionAllowed(DEFAULT_TRANSITIONS, 'resolved', 'reopened')).toBe(true);
  });

  it('does not make closed a free-for-all — only reopened is reachable from it', () => {
    expect(DEFAULT_TRANSITIONS.closed).toEqual(['reopened']);
  });
});

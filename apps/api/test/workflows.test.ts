import { describe, it, expect } from 'vitest';
import { isTransitionAllowed, buildMap, DEFAULT_TRANSITIONS } from '../src/modules/workflows.js';

describe('buildMap', () => {
  it('groups flat transition rows into a map', () => {
    const map = buildMap([
      { from_status: 'open', to_status: 'in_progress' },
      { from_status: 'open', to_status: 'closed' },
      { from_status: 'in_progress', to_status: 'closed' },
    ]);
    expect(map).toEqual({ open: ['in_progress', 'closed'], in_progress: ['closed'] });
  });
});

describe('isTransitionAllowed', () => {
  it('honors the default map', () => {
    expect(isTransitionAllowed(DEFAULT_TRANSITIONS, 'in_progress', 'resolved')).toBe(true);
    expect(isTransitionAllowed(DEFAULT_TRANSITIONS, 'new', 'resolved')).toBe(false);
  });
  it('returns false for unknown from-status', () => {
    expect(isTransitionAllowed(DEFAULT_TRANSITIONS, 'nonexistent', 'closed')).toBe(false);
  });
  it('works with a custom map', () => {
    const custom = { triage: ['fast_track'], fast_track: ['done'] };
    expect(isTransitionAllowed(custom, 'triage', 'fast_track')).toBe(true);
    expect(isTransitionAllowed(custom, 'triage', 'done')).toBe(false);
  });
});

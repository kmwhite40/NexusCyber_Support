import { describe, it, expect } from 'vitest';
import { summarizeScores } from '../src/modules/posture.js';

// Watched live in production: an agent's dashboard calls /posture/score and /posture/findings with
// no organizationId, because it is a CROSS-CUSTOMER view. Both refused with
// "organizationId required", so the Security posture panel was blank and Open findings read 0 on
// every load — a failing request that looked like "nothing to report".
describe('summarizeScores', () => {
  it('reports the WORST customer, not a flattering average', () => {
    // An average would show 72 here and hide the customer at 31. On a desk whose job is noticing
    // trouble, a single number that averages away one failing tenant is worse than no number.
    const s = summarizeScores([{ orgId: 'a', score: 98 }, { orgId: 'b', score: 88 }, { orgId: 'c', score: 31 }]);
    expect(s.overall_score).toBe(31);
    expect(s.worst_organization_id).toBe('c');
    expect(s.organizations).toBe(3);
  });

  it('is just the score when the agent looks after one customer', () => {
    const s = summarizeScores([{ orgId: 'a', score: 77 }]);
    expect(s.overall_score).toBe(77);
    expect(s.organizations).toBe(1);
  });

  // No assigned orgs must not render as a perfect score. "Nothing measured" and "nothing wrong"
  // are different claims, and the tile should not make the confident one.
  it('reports nothing measured rather than a perfect 100', () => {
    const s = summarizeScores([]);
    expect(s.overall_score).toBeNull();
    expect(s.organizations).toBe(0);
    expect(s.grade).toBeNull();
  });

  it('grades the worst score', () => {
    expect(summarizeScores([{ orgId: 'a', score: 95 }]).grade).toBe('A');
    expect(summarizeScores([{ orgId: 'a', score: 95 }, { orgId: 'b', score: 61 }]).grade).toBe('D');
  });
});

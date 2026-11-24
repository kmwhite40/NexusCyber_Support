import { describe, it, expect } from 'vitest';
import {
  score, rating, highWaterImpact, nextReviewAt, appetiteState, canTransition, acceptanceActive,
  treatmentProgress, overdueTreatments, simulateFair, samplePert, prng, heatmap, summarizeOrg,
  rankPortfolio, fromFindingSeverity, riskRef, csvCell, toCsv, type ScoredRisk,
  methodology, ratingsOf, ACTIVE_METHODOLOGY, METHODOLOGIES, REVIEW_DAYS,
} from '../src/modules/risk-scoring.js';

const NOW = new Date('2026-11-11T00:00:00Z');

function risk(over: Partial<ScoredRisk> = {}): ScoredRisk {
  return {
    organization_id: 'o1', status: 'assessed',
    inherent_likelihood: 4, inherent_impact: 5,
    residual_likelihood: 3, residual_impact: 4,
    target_likelihood: 2, target_impact: 3,
    next_review_at: '2027-01-01T00:00:00Z',
    fair_results: null,
    ...over,
  };
}

describe('score / rating', () => {
  it('multiplies likelihood by impact', () => {
    expect(score(3, 4)).toBe(12);
    expect(score(5, 5)).toBe(25);
  });
  it('refuses values off the 5x5 matrix rather than inventing a score', () => {
    expect(() => score(0, 3)).toThrow(RangeError);
    expect(() => score(3, 6)).toThrow(RangeError);
    expect(() => score(2.5, 3)).toThrow(RangeError);
  });
  // Every score the 5x5 matrix can produce, and every band boundary, under both versions.
  const REACHABLE = [...new Set([1, 2, 3, 4, 5].flatMap((l) => [1, 2, 3, 4, 5].map((i) => l * i)))].sort((a, b) => a - b);
  it('v1 (original, frozen) bands every reachable score', () => {
    const v1 = (s: number) => rating(s, 'nexus-5x5@1');
    expect([1, 2, 3].map(v1)).toEqual(['very_low', 'very_low', 'very_low']);
    expect([4, 5, 6].map(v1)).toEqual(['low', 'low', 'low']);
    expect([8, 9, 10, 12].map(v1)).toEqual(['moderate', 'moderate', 'moderate', 'moderate']);
    expect([15, 16].map(v1)).toEqual(['high', 'high']);
    expect([20, 25].map(v1)).toEqual(['very_high', 'very_high']);
  });
  it('v2 (Anchor default, active) bands every reachable score: 1-4 Low, 5-9 Moderate, 10-14 High, 15-19 Very High, 20-25 Critical', () => {
    expect(ACTIVE_METHODOLOGY).toBe('nexus-5x5@2');
    const expected = (s: number) => (s >= 20 ? 'critical' : s >= 15 ? 'very_high' : s >= 10 ? 'high' : s >= 5 ? 'moderate' : 'low');
    for (const s of REACHABLE) expect([s, rating(s)]).toEqual([s, expected(s)]);
    // The boundaries themselves, including scores the matrix cannot produce (e.g. 7, 11, 14, 19).
    expect([4, 5, 9, 10, 14, 15, 19, 20, 25].map((s) => rating(s))).toEqual(
      ['low', 'moderate', 'moderate', 'high', 'high', 'very_high', 'very_high', 'critical', 'critical']);
  });
  it('treats each methodology version as an ordered, complete, immutable band set', () => {
    for (const m of Object.values(METHODOLOGIES)) {
      const mins = m.bands.map((b) => b.min);
      expect(mins).toEqual([...mins].sort((a, b) => b - a)); // worst first, strictly descending
      expect(mins[mins.length - 1]).toBe(1); // every score 1-25 lands in a band
      expect(m.key).toBe(`${m.family}@${m.version}`);
    }
    expect(ratingsOf()).toEqual(['critical', 'very_high', 'high', 'moderate', 'low']);
    expect(() => methodology('nexus-5x5@99')).toThrow(/unknown scoring methodology/);
  });
  it('keeps review cadence on the score, not on the re-banded label', () => {
    // 16 is "high" under v1 and "very_high" under v2; its review interval must not move.
    expect(nextReviewAt(16, NOW).getTime() - NOW.getTime()).toBe(REVIEW_DAYS.high * 86_400_000);
  });
});

describe('highWaterImpact (FIPS 199)', () => {
  it('takes the maximum, never the average', () => {
    expect(highWaterImpact({ confidentiality: 5, integrity: 1, availability: 1 })).toBe(5);
  });
  it('treats 0 as not-applicable and returns null when nothing was rated', () => {
    expect(highWaterImpact({ confidentiality: 0 })).toBeNull();
    expect(highWaterImpact({})).toBeNull();
    expect(highWaterImpact(null)).toBeNull();
  });
  it('rejects out-of-range dimensions', () => {
    expect(() => highWaterImpact({ financial: 7 })).toThrow(RangeError);
  });
});

describe('review cadence', () => {
  it('reviews hotter risks sooner', () => {
    const day = 86_400_000;
    expect((nextReviewAt(25, NOW).getTime() - NOW.getTime()) / day).toBe(30);
    expect((nextReviewAt(2, NOW).getTime() - NOW.getTime()) / day).toBe(365);
  });
  it('honours an explicit override', () => {
    expect((nextReviewAt(25, NOW, 7).getTime() - NOW.getTime()) / 86_400_000).toBe(7);
  });
});

describe('appetiteState', () => {
  const a = { appetite_score: 9, tolerance_score: 15 };
  it('classifies against the organization thresholds', () => {
    expect(appetiteState(9, a)).toBe('within');
    expect(appetiteState(10, a)).toBe('above_appetite');
    expect(appetiteState(15, a)).toBe('above_appetite');
    expect(appetiteState(16, a)).toBe('above_tolerance');
  });
  it('is per organization: the same risk can be fine at one customer and reportable at another', () => {
    expect(appetiteState(12, { appetite_score: 12, tolerance_score: 20 })).toBe('within');
    expect(appetiteState(12, { appetite_score: 4, tolerance_score: 8 })).toBe('above_tolerance');
  });
});

describe('lifecycle', () => {
  it('walks identified -> assessed -> treating -> monitoring -> closed', () => {
    expect(canTransition('identified', 'assessed')).toBe(true);
    expect(canTransition('assessed', 'treating')).toBe(true);
    expect(canTransition('treating', 'monitoring')).toBe(true);
    expect(canTransition('monitoring', 'closed')).toBe(true);
  });
  it('never enters accepted by a bare transition', () => {
    for (const from of ['identified', 'assessed', 'treating', 'monitoring', 'closed'] as const) {
      expect(canTransition(from, 'accepted')).toBe(false);
    }
  });
  it('reopens a closed risk only to identified', () => {
    expect(canTransition('closed', 'identified')).toBe(true);
    expect(canTransition('closed', 'treating')).toBe(false);
  });
});

describe('acceptanceActive', () => {
  it('requires an approved, unexpired, time-boxed acceptance', () => {
    expect(acceptanceActive({ acceptance_status: 'approved', acceptance_expires_at: '2027-01-01' }, NOW)).toBe(true);
    expect(acceptanceActive({ acceptance_status: 'approved', acceptance_expires_at: '2026-01-01' }, NOW)).toBe(false);
    expect(acceptanceActive({ acceptance_status: 'approved', acceptance_expires_at: null }, NOW)).toBe(false);
    expect(acceptanceActive({ acceptance_status: 'requested', acceptance_expires_at: '2027-01-01' }, NOW)).toBe(false);
  });
});

describe('treatment plan', () => {
  const items = [
    { status: 'done', due_at: '2026-01-01' },
    { status: 'in_progress', due_at: '2026-10-01' },
    { status: 'planned', due_at: '2027-01-01' },
    { status: 'cancelled', due_at: '2026-01-01' },
  ];
  it('computes progress over non-cancelled items', () => {
    expect(treatmentProgress(items)).toBe(33);
    expect(treatmentProgress([])).toBeNull();
  });
  it('counts only open items past due', () => {
    expect(overdueTreatments(items, NOW)).toBe(1);
  });
});

describe('FAIR Monte Carlo', () => {
  const inputs = { lef: { min: 0.1, likely: 0.5, max: 2 }, lm: { min: 50_000, likely: 250_000, max: 2_000_000 } };

  it('is reproducible for the same seed', () => {
    expect(simulateFair(inputs, 2000)).toEqual(simulateFair(inputs, 2000));
  });
  it('produces ordered percentiles inside the possible range', () => {
    const r = simulateFair(inputs, 5000);
    expect(r.p10).toBeLessThanOrEqual(r.p50);
    expect(r.p50).toBeLessThanOrEqual(r.p90);
    expect(r.p90).toBeLessThanOrEqual(r.p95);
    expect(r.p10).toBeGreaterThanOrEqual(0.1 * 50_000);
    expect(r.p95).toBeLessThanOrEqual(2 * 2_000_000);
  });
  it('lands near the analytic PERT means', () => {
    // E[PERT] = (min + 4*likely + max) / 6, and the draws are independent, so E[ALE] = E[LEF]*E[LM].
    const eLef = (0.1 + 4 * 0.5 + 2) / 6;
    const eLm = (50_000 + 4 * 250_000 + 2_000_000) / 6;
    const r = simulateFair(inputs, 20_000);
    expect(Math.abs(r.mean - eLef * eLm) / (eLef * eLm)).toBeLessThan(0.05);
  });
  it('handles a degenerate (point) range', () => {
    const r = simulateFair({ lef: { min: 1, likely: 1, max: 1 }, lm: { min: 1000, likely: 1000, max: 1000 } }, 100);
    expect(r.p50).toBe(1000);
    expect(r.mean).toBe(1000);
  });
  it('rejects inverted or negative ranges', () => {
    expect(() => simulateFair({ lef: { min: 2, likely: 1, max: 3 }, lm: inputs.lm })).toThrow(RangeError);
    expect(() => simulateFair({ lef: inputs.lef, lm: { min: -1, likely: 1, max: 3 } })).toThrow(RangeError);
  });
  it('keeps PERT draws within [min, max]', () => {
    const rand = prng(42);
    for (let i = 0; i < 1000; i++) {
      const v = samplePert({ min: 10, likely: 12, max: 50 }, rand);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(50);
    }
  });
});

describe('heatmap', () => {
  it('counts open risks per cell on the chosen basis', () => {
    const g = heatmap([risk(), risk(), risk({ status: 'closed' })], 'residual');
    expect(g[2][3]).toBe(2); // L3 x I4
    expect(g.flat().reduce((a, b) => a + b, 0)).toBe(2);
    expect(heatmap([risk()], 'inherent')[3][4]).toBe(1);
  });
  it('skips risks with no target on the target basis', () => {
    expect(heatmap([risk({ target_likelihood: null, target_impact: null })], 'target').flat().every((n) => n === 0)).toBe(true);
  });
});

describe('portfolio', () => {
  it('summarizes an organization against its own appetite', () => {
    const s = summarizeOrg('o1', [
      risk({ residual_likelihood: 5, residual_impact: 4 }), // 20 above tolerance
      risk({ residual_likelihood: 3, residual_impact: 4 }), // 12 above appetite
      risk({ residual_likelihood: 1, residual_impact: 2, next_review_at: '2026-01-01' }), // 2, overdue
      risk({ status: 'closed', residual_likelihood: 5, residual_impact: 5 }),
    ], { appetite_score: 9, tolerance_score: 15 }, NOW);
    expect(s.open).toBe(3);
    expect(s.above_appetite).toBe(2);
    expect(s.above_tolerance).toBe(1);
    expect(s.overdue_reviews).toBe(1);
    expect(s.worst_residual).toBe(20);
    expect(s.by_rating.critical).toBe(1); // 20 under the active (v2) bands
    expect(s.by_rating.high).toBe(1); // 12
    expect(s.by_rating.low).toBe(1); // 2
    expect(s.ale_p50).toBeNull(); // nothing quantified is not $0
  });
  it('sums quantified exposure', () => {
    const fr = { mean: 1, p10: 1, p50: 1000, p90: 5000, p95: 6000, iterations: 1, seed: 1 };
    const s = summarizeOrg('o1', [risk({ fair_results: fr }), risk({ fair_results: fr }), risk()], undefined, NOW);
    expect(s.ale_p50).toBe(2000);
    expect(s.ale_p90).toBe(10000);
    expect(s.quantified).toBe(2);
  });
  it('ranks the organization in trouble first', () => {
    const base = summarizeOrg('calm', [risk({ residual_likelihood: 1, residual_impact: 1 })], undefined, NOW);
    const hot = summarizeOrg('hot', [risk({ residual_likelihood: 5, residual_impact: 5 })], undefined, NOW);
    expect(rankPortfolio([base, hot]).map((r) => r.organization_id)).toEqual(['hot', 'calm']);
  });
});

describe('helpers', () => {
  it('maps finding severity to a starting assessment', () => {
    expect(fromFindingSeverity('critical')).toEqual({ likelihood: 4, impact: 5 });
    expect(fromFindingSeverity('unknown')).toEqual({ likelihood: 1, impact: 2 });
  });
  it('formats per-organization references', () => {
    expect(riskRef(7)).toBe('R-0007');
  });
  it('escapes CSV and neutralises formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });
});

describe('foldTrend', () => {
  it('folds per-score aggregates into weekly points, keeping empty weeks', async () => {
    const { foldTrend } = await import('../src/modules/risk-scoring.js');
    const pts = foldTrend([
      { at: '2026-11-16', inherent_score: 20, open: 2, inherent_sum: 40, residual_sum: 12, target_sum: null },
      { at: '2026-11-16', inherent_score: 4, open: 1, inherent_sum: 4, residual_sum: 2, target_sum: 1 },
      { at: '1999-01-01', inherent_score: 9, open: 9, inherent_sum: 81, residual_sum: 81, target_sum: null },
    ], ['2026-11-09', '2026-11-16']);
    expect(pts[0]).toMatchObject({ week: '2026-11-09', open: 0, inherent_total: 0, target_total: null });
    expect(pts[1]).toMatchObject({ open: 3, inherent_total: 44, residual_total: 14, target_total: 1 });
    expect(pts[1].by_inherent_rating).toEqual({ very_low: 0, low: 1, moderate: 0, high: 0, very_high: 0, critical: 2 });
  });
});

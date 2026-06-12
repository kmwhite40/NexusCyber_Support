import { describe, it, expect } from 'vitest';
import { derivePriority } from '../src/modules/tickets.js';
import { riskScore, grade } from '../src/modules/posture.js';

describe('Ticket priority matrix (impact × urgency)', () => {
  it('maps the corners of the matrix', () => {
    expect(derivePriority(1, 1)).toBe('P1');
    expect(derivePriority(1, 4)).toBe('P3');
    expect(derivePriority(4, 1)).toBe('P3');
    expect(derivePriority(4, 4)).toBe('P4');
    expect(derivePriority(3, 3)).toBe('P3');
  });
  it('falls back to P3 for out-of-range input', () => {
    expect(derivePriority(9 as number, 9 as number)).toBe('P3');
  });
});

describe('Posture scoring', () => {
  it('risk weight increases with severity', () => {
    expect(riskScore('critical')).toBeGreaterThan(riskScore('high'));
    expect(riskScore('high')).toBeGreaterThan(riskScore('moderate'));
    expect(riskScore('moderate')).toBeGreaterThan(riskScore('low'));
  });
  it('grades the score bands A–F', () => {
    expect(grade(95)).toBe('A');
    expect(grade(85)).toBe('B');
    expect(grade(75)).toBe('C');
    expect(grade(65)).toBe('D');
    expect(grade(40)).toBe('F');
  });
});

import { describe, it, expect } from 'vitest';
import { sanitizeLayout } from '../src/modules/dashboards.js';
describe('sanitizeLayout', () => {
  it('drops unknown widget types and preserves order', () => {
    expect(sanitizeLayout([{ type: 'kpis' }, { type: 'bogus' }, { type: 'top_findings' }])).toEqual([{ type: 'kpis' }, { type: 'top_findings' }]);
  });
  it('returns [] for non-arrays and malformed entries', () => {
    expect(sanitizeLayout(null)).toEqual([]);
    expect(sanitizeLayout([{}, 3, 'x'])).toEqual([]);
  });
});

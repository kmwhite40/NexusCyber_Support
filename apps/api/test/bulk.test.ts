import { describe, it, expect } from 'vitest';
import { isValidBulkAction, summarize, BULK_ACTIONS } from '../src/modules/bulk.js';

describe('isValidBulkAction', () => {
  it('accepts known actions', () => {
    for (const a of BULK_ACTIONS) expect(isValidBulkAction(a)).toBe(true);
  });
  it('rejects unknown actions', () => {
    expect(isValidBulkAction('delete_everything')).toBe(false);
  });
});

describe('summarize', () => {
  it('counts succeeded and failed', () => {
    const s = summarize([{ id: '1', ok: true }, { id: '2', ok: false, error: 'x' }, { id: '3', ok: true }]);
    expect(s).toEqual({ total: 3, succeeded: 2, failed: 1 });
  });
  it('handles an empty batch', () => {
    expect(summarize([])).toEqual({ total: 0, succeeded: 0, failed: 0 });
  });
});

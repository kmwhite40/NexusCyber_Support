import { describe, it, expect } from 'vitest';
import { decideHold } from '../src/modules/retention/sweep-decision.js';

const hold = { retain_until: '2027-09-02T00:00:00.000Z' };
const inWindow = new Date('2027-01-01T00:00:00Z');
const afterWindow = new Date('2027-10-01T00:00:00Z');

describe('decideHold', () => {
  it('touches a present account inside its window', () => {
    expect(decideHold(hold, true, inWindow)).toEqual({ action: 'touch' });
  });

  it('BREACHES when the account is gone before its date', () => {
    expect(decideHold(hold, false, inWindow)).toEqual({ action: 'breach' });
  });

  it('is eligible when the date has passed and the account is still there', () => {
    expect(decideHold(hold, true, afterWindow)).toEqual({ action: 'eligible' });
  });

  it('is disposed when the account is gone after its date', () => {
    // Someone did the right thing outside Nexus. Recording it is enough; no alarm.
    expect(decideHold(hold, false, afterWindow)).toEqual({ action: 'disposed' });
  });

  it('does NOTHING when the account could not be checked', () => {
    // A tenant outage must never read as "account confirmed present" — that is the one reading
    // that would let a real breach pass unnoticed. Not even last_checked_at may be stamped,
    // which is why this is 'none' and not 'touch'.
    expect(decideHold(hold, null, inWindow)).toEqual({ action: 'none' });
    expect(decideHold(hold, null, afterWindow)).toEqual({ action: 'none' });
  });

  it('treats the exact retain_until instant as expired', () => {
    expect(decideHold(hold, true, new Date('2027-09-02T00:00:00.000Z'))).toEqual({ action: 'eligible' });
  });

  it('accepts a Date for retain_until, as pg returns it', () => {
    expect(decideHold({ retain_until: new Date('2027-09-02T00:00:00Z') }, true, inWindow))
      .toEqual({ action: 'touch' });
  });
});

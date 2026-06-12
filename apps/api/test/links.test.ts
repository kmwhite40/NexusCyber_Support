import { describe, it, expect } from 'vitest';
import { isValidLinkType, inverseLabel, LINK_TYPES } from '../src/modules/links.js';

describe('isValidLinkType', () => {
  it('accepts known link types', () => {
    for (const t of LINK_TYPES) expect(isValidLinkType(t)).toBe(true);
  });
  it('rejects unknown link types', () => {
    expect(isValidLinkType('frobnicates')).toBe(false);
  });
});

describe('inverseLabel', () => {
  it('maps each link type to a human inverse label', () => {
    expect(inverseLabel('duplicate_of')).toBe('has duplicate');
    expect(inverseLabel('blocks')).toBe('blocked by');
    expect(inverseLabel('child_of')).toBe('parent of');
    expect(inverseLabel('caused_by')).toBe('causes');
  });
});

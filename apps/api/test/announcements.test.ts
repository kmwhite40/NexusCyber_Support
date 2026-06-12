import { describe, it, expect } from 'vitest';
import { isActive } from '../src/modules/announcements.js';

const now = new Date('2026-06-12T12:00:00Z');

describe('isActive', () => {
  it('is true for an active announcement inside its window', () => {
    expect(isActive({ active: true, starts_at: '2026-06-12T00:00:00Z', ends_at: '2026-06-13T00:00:00Z' }, now)).toBe(true);
  });
  it('is false when inactive', () => {
    expect(isActive({ active: false, starts_at: '2026-06-12T00:00:00Z', ends_at: null }, now)).toBe(false);
  });
  it('is false before it starts', () => {
    expect(isActive({ active: true, starts_at: '2026-06-13T00:00:00Z', ends_at: null }, now)).toBe(false);
  });
  it('is false after it ends', () => {
    expect(isActive({ active: true, starts_at: '2026-06-10T00:00:00Z', ends_at: '2026-06-11T00:00:00Z' }, now)).toBe(false);
  });
  it('treats a null end as open-ended', () => {
    expect(isActive({ active: true, starts_at: '2026-06-10T00:00:00Z', ends_at: null }, now)).toBe(true);
  });
});

import { it, expect, describe } from 'vitest';
import { hasDb, describeDb } from './db.js';

describe('integration-test scaffolding', () => {
  it('exposes hasDb as a boolean', () => {
    expect(typeof hasDb).toBe('boolean');
  });
});

describeDb('a DB-backed suite (runs only when DATABASE_URL is set)', () => {
  it('runs when a database is configured', () => {
    expect(hasDb).toBe(true);
  });
});

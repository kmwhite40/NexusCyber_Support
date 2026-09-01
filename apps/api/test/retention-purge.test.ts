import { describe, it, expect } from 'vitest';
import { sensitivePurgeSql } from '../src/jobs/retention-purge.js';

describe('sensitivePurgeSql', () => {
  it('targets only closed or resolved tickets', () => {
    const sql = sensitivePurgeSql();
    expect(sql).toContain('ticket_sensitive_fields');
    expect(sql).toMatch(/status IN \('resolved','closed'\)/);
  });
});

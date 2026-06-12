import { describe, it, expect } from 'vitest';
import { toCef, type ExportableRow } from '../src/modules/audit.js';

const row: ExportableRow = {
  id: '11111111-1111-1111-1111-111111111111',
  actor_id: 'actor-1',
  actor_plane: 'nexus',
  action: 'posture.finding.create',
  resource_type: 'posture_finding',
  resource_id: 'res-1',
  detail: { severity: 'high' },
  created_at: '2026-01-01T00:00:00.000Z',
  prev_hash: null,
  row_hash: 'abc',
};

describe('toCef', () => {
  it('produces a CEF line with the required prefix and key fields', () => {
    const line = toCef(row);
    expect(line.startsWith('CEF:0|Nexus|Platform|1.0|posture.finding.create|posture.finding.create|')).toBe(true);
    expect(line).toContain('suser=actor-1');
    expect(line).toContain('act=posture.finding.create');
    expect(line).toContain('externalId=11111111-1111-1111-1111-111111111111');
  });

  it('escapes pipes and backslashes in the header and equals in extensions', () => {
    const line = toCef({ ...row, action: 'a|b\\c' });
    expect(line).toContain('a\\|b\\\\c');
  });
});

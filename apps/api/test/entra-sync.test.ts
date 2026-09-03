import { describe, it, expect, vi } from 'vitest';
import { applyDeviceSync } from '../src/integrations/entra/sync.js';
import type { ManagedDevice } from '../src/integrations/entra/device-map.js';

/** A fake sql that branches on the statement, matching on content rather than prefix. */
function fakeSql(existing: Array<{ id: string; external_id: string; status: string }>, opts: { insertFails?: boolean } = {}) {
  const retired: string[] = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    if (/INSERT INTO configuration_items/.test(text)) {
      if (opts.insertFails) throw new Error('unique violation');
      return { rows: [{ inserted: true }] };
    }
    if (/SELECT id, external_id, status/.test(text)) return { rows: existing };
    if (/UPDATE configuration_items SET status/.test(text)) {
      retired.push(params![0] as string);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { sql: { query } as any, retired };
}

describe('applyDeviceSync', () => {
  it('upserts each device and retires CIs whose device is gone', async () => {
    const devices: ManagedDevice[] = [
      { azureADDeviceId: 'aad-1', deviceName: 'A' },
      { azureADDeviceId: 'aad-2', deviceName: 'B' },
    ];
    const { sql, retired } = fakeSql([
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-gone', external_id: 'aad-old', status: 'active' },
    ]);
    const stats = await applyDeviceSync(sql, 'org-1', devices);
    expect(stats.created).toBe(2);
    expect(stats.retired).toBe(1);
    expect(retired).toEqual(['ci-gone']);
  });

  it('skips unusable records with no id', async () => {
    const { sql } = fakeSql([]);
    const stats = await applyDeviceSync(sql, 'org-1', [{ deviceName: 'orphan' }]);
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(0);
  });

  it('REFUSES to retire everything when enumeration returned no devices', async () => {
    // The worst available outcome: an enumeration that comes back empty for a reason other than
    // "this tenant has no devices" would retire a customer's entire device inventory in one
    // sweep.Zero devices plus existing active CIs is suspicious enough to stop and ask.
    const { sql, retired } = fakeSql([
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-2', external_id: 'aad-2', status: 'active' },
    ]);
    const stats = await applyDeviceSync(sql, 'org-1', []);
    expect(retired).toEqual([]);
    expect(stats.retired).toBe(0);
    expect(stats.skippedRetirement).toBe(true);
  });

  it('still retires normally when SOME devices came back', async () => {
    const { sql, retired } = fakeSql([
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-2', external_id: 'aad-2', status: 'active' },
    ]);
    const stats = await applyDeviceSync(sql, 'org-1', [{ azureADDeviceId: 'aad-1' }]);
    expect(retired).toEqual(['ci-2']);
    expect(stats.skippedRetirement).toBe(false);
  });

  it('retires nothing if an upsert throws — a partial sync must not look complete', async () => {
    const { sql, retired } = fakeSql(
      [{ id: 'ci-old', external_id: 'aad-old', status: 'active' }], { insertFails: true },
    );
    await expect(applyDeviceSync(sql, 'org-1', [{ azureADDeviceId: 'aad-1' }])).rejects.toThrow();
    expect(retired).toEqual([]);
  });
});

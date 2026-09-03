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


  // The zero-device guard catches the total-collapse case. It does NOT catch the case the
  // reviewer pushed on: an app registration narrowed to a subset, a licence change, an Intune
  // scope tag — anything that returns SOME devices. Five of five hundred sails past a
  // length === 0 check and retires the other 495 as a normal, successful run.
  it('refuses a run that would retire most of the inventory, not just all of it', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({
      id: `ci-${i}`, external_id: `aad-${i}`, status: 'active',
    }));
    const devices: ManagedDevice[] = [
      { azureADDeviceId: 'aad-0', deviceName: 'A' },
      { azureADDeviceId: 'aad-1', deviceName: 'B' },
      { azureADDeviceId: 'aad-2', deviceName: 'C' },
    ];
    const { sql, retired } = fakeSql(existing);
    const stats = await applyDeviceSync(sql, 'org-1', devices);
    expect(stats.skippedRetirement).toBe(true);
    expect(stats.retired).toBe(0);
    expect(retired).toEqual([]);
    // The upserts still happen — the devices that DID come back are real and current.
    expect(stats.created).toBe(3);
    expect(stats.skipReason).toMatch(/97 of 100/);
  });

  it('does not trip the proportion guard on a small inventory', async () => {
    // One of two devices leaving is an ordinary Tuesday. A proportion test alone would call that
    // a 50% collapse and refuse forever, so the guard needs a floor — below it, only the
    // zero-device case is suspicious.
    const { sql, retired } = fakeSql([
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-2', external_id: 'aad-2', status: 'active' },
    ]);
    const stats = await applyDeviceSync(sql, 'org-1', [{ azureADDeviceId: 'aad-1', deviceName: 'A' }]);
    expect(stats.skippedRetirement).toBe(false);
    expect(stats.retired).toBe(1);
    expect(retired).toEqual(['ci-2']);
  });

  it('lets a large but sub-threshold retirement through', async () => {
    // 20 of 100 is a fleet refresh, not a broken credential. The guard must not become a wall
    // that stops the feature doing its job.
    const existing = Array.from({ length: 100 }, (_, i) => ({
      id: `ci-${i}`, external_id: `aad-${i}`, status: 'active',
    }));
    const devices: ManagedDevice[] = Array.from({ length: 80 }, (_, i) => ({
      azureADDeviceId: `aad-${i}`, deviceName: `D${i}`,
    }));
    const { sql } = fakeSql(existing);
    const stats = await applyDeviceSync(sql, 'org-1', devices);
    expect(stats.skippedRetirement).toBe(false);
    expect(stats.retired).toBe(20);
  });


  // SBS's tenant carries 11 personal (BYOD) devices among 84. Syncing them would put employees'
  // own phones in the CMDB with their UPN attached — a privacy call nobody had made, and easier
  // to make before the first sync than to explain afterwards.
  it('does not create CIs for personal (BYOD) devices', async () => {
    const { sql } = fakeSql([]);
    const stats = await applyDeviceSync(sql, 'org-1', [
      { azureADDeviceId: 'aad-corp', deviceName: 'LAPTOP', managedDeviceOwnerType: 'company' },
      { azureADDeviceId: 'aad-byod', deviceName: 'Ajay iPhone', managedDeviceOwnerType: 'personal' },
    ]);
    expect(stats.created).toBe(1);
    expect(stats.excludedPersonal).toBe(1);
  });

  // The transition case, and the one that could do damage: an org synced BEFORE the exclusion
  // existed has personal CIs already. They must be RETIRED (they no longer belong in the CMDB),
  // never left behind as permanently-stale rows that no future sync will ever touch again.
  it('retires personal CIs that a previous sync created', async () => {
    const { sql, retired } = fakeSql([
      { id: 'ci-corp', external_id: 'aad-corp', status: 'active' },
      { id: 'ci-byod', external_id: 'aad-byod', status: 'active' },
    ]);
    const stats = await applyDeviceSync(sql, 'org-1', [
      { azureADDeviceId: 'aad-corp', deviceName: 'LAPTOP', managedDeviceOwnerType: 'company' },
      { azureADDeviceId: 'aad-byod', deviceName: 'Ajay iPhone', managedDeviceOwnerType: 'personal' },
    ]);
    expect(retired).toEqual(['ci-byod']);
    expect(stats.retired).toBe(1);
  });

  // An unknown/absent ownerType is NOT personal. Excluding on missing data would quietly drop
  // corporate devices whose Intune record is incomplete — the tenant has one such device.
  it('keeps devices whose ownerType is unknown or absent', async () => {
    const { sql } = fakeSql([]);
    const stats = await applyDeviceSync(sql, 'org-1', [
      { azureADDeviceId: 'aad-1', deviceName: 'A', managedDeviceOwnerType: 'unknown' },
      { azureADDeviceId: 'aad-2', deviceName: 'B' },
    ]);
    expect(stats.created).toBe(2);
    expect(stats.excludedPersonal).toBe(0);
  });

  // The exclusion must not be able to trip the collapse guard into refusing a legitimate run:
  // a mostly-BYOD tenant would otherwise look like a vanished fleet.
  it('counts excluded personal devices as a real enumeration, not an empty one', async () => {
    const { sql } = fakeSql([{ id: 'ci-1', external_id: 'aad-corp', status: 'active' }]);
    const stats = await applyDeviceSync(sql, 'org-1', [
      { azureADDeviceId: 'aad-corp', deviceName: 'LAPTOP', managedDeviceOwnerType: 'company' },
      { azureADDeviceId: 'aad-b1', deviceName: 'phone1', managedDeviceOwnerType: 'personal' },
      { azureADDeviceId: 'aad-b2', deviceName: 'phone2', managedDeviceOwnerType: 'personal' },
    ]);
    expect(stats.skippedRetirement).toBe(false);
  });


  // THE REGRESSION THE BYOD EXCLUSION INTRODUCED.
  //
  // Before the exclusion, `devices.length === 0` was a sound proxy for "we saw nothing", because
  // every returned device landed in `seen`. Excluding personal devices broke that equivalence:
  // a tenant can now return rows while contributing NOTHING to `seen`.
  //
  // An org with 8 corporate CIs — below the proportion guard's floor of 10 — whose app
  // registration narrows so Graph stops returning company devices but keeps returning personal
  // ones has returned > 0, so the zero-check does not fire, and activeCis < 10, so the
  // proportion check never runs. All 8 retire, reported as a clean sync.
  it('treats an enumeration of ONLY personal devices as a collapse, even below the floor', async () => {
    const existing = Array.from({ length: 8 }, (_, i) => ({
      id: `ci-${i}`, external_id: `aad-${i}`, status: 'active',
    }));
    const { sql, retired } = fakeSql(existing);
    const stats = await applyDeviceSync(sql, 'org-1', [
      { azureADDeviceId: 'p1', deviceName: 'phone1', managedDeviceOwnerType: 'personal' },
      { azureADDeviceId: 'p2', deviceName: 'phone2', managedDeviceOwnerType: 'personal' },
    ]);
    expect(stats.skippedRetirement).toBe(true);
    expect(stats.retired).toBe(0);
    expect(retired).toEqual([]);
  });

  it('retires nothing if an upsert throws — a partial sync must not look complete', async () => {
    const { sql, retired } = fakeSql(
      [{ id: 'ci-old', external_id: 'aad-old', status: 'active' }], { insertFails: true },
    );
    await expect(applyDeviceSync(sql, 'org-1', [{ azureADDeviceId: 'aad-1' }])).rejects.toThrow();
    expect(retired).toEqual([]);
  });
});

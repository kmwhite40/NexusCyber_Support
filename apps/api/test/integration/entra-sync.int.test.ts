import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { applyDeviceSync, claimSyncLease, releaseSyncLease } from '../../src/integrations/entra/sync.js';
import type { ManagedDevice } from '../../src/integrations/entra/device-map.js';

// The unit suite drives applyDeviceSync through a fake `sql`, which proves the ORDERING and the
// guards but cannot prove the SQL. Everything that actually breaks in production lives in the
// statements: the ON CONFLICT target must match the partial unique index from migration 0072, the
// `xmax = 0` inserted/updated discrimination must behave the way the upsert counts assume, and the
// jsonb attributes must round-trip. This suite runs the real statements against real Postgres.
const ORG = '00000000-0000-4000-8000-0000000e57a1';

function device(id: string, name: string): ManagedDevice {
  return {
    azureADDeviceId: id,
    id: `intune-${id}`,
    deviceName: name,
    userPrincipalName: `${name}@example.gov`,
    operatingSystem: 'Windows',
    osVersion: '10.0.26100',
    complianceState: 'compliant',
    isEncrypted: true,
    lastSyncDateTime: '2026-09-01T00:00:00Z',
    manufacturer: 'Dell Inc.',
    model: 'Latitude 5440',
    serialNumber: `SN-${id}`,
    managedDeviceOwnerType: 'company',
  } as ManagedDevice;
}

describeDb('applyDeviceSync against real Postgres', () => {
  beforeAll(async () => {
    await withSystemContext(async (sql) => {
      await sql.query(
        `INSERT INTO organizations (id, name, cloud, status) VALUES ($1,'Entra Sync Fixture Org','gcchigh','active')
         ON CONFLICT (id) DO NOTHING`, [ORG]);
      await sql.query('DELETE FROM configuration_items WHERE organization_id=$1', [ORG]);
    });
  });

  afterAll(async () => {
    await withSystemContext(async (sql) => {
      await sql.query('DELETE FROM configuration_items WHERE organization_id=$1', [ORG]);
      await sql.query('DELETE FROM organizations WHERE id=$1', [ORG]);
    });
  });

  it('creates, then updates without duplicating, then retires what is gone', async () => {
    const first = await withSystemContext((sql) =>
      applyDeviceSync(sql, ORG, [device('dev-a', 'LAPTOP-A'), device('dev-b', 'LAPTOP-B')]));
    expect(first).toEqual({ created: 2, updated: 0, retired: 0, skippedRetirement: false });

    // Same devices again: the upsert must recognise them, not insert a second copy. This is the
    // assertion that the ON CONFLICT target lines up with the partial index.
    const renamed = device('dev-a', 'LAPTOP-A-RENAMED');
    const second = await withSystemContext((sql) =>
      applyDeviceSync(sql, ORG, [renamed, device('dev-b', 'LAPTOP-B')]));
    expect(second).toEqual({ created: 0, updated: 2, retired: 0, skippedRetirement: false });

    const rows = await withSystemContext(async (sql) => (await sql.query(
      `SELECT external_id, name, status, source, attributes
         FROM configuration_items WHERE organization_id=$1 ORDER BY external_id`, [ORG])).rows);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('LAPTOP-A-RENAMED');
    expect(rows[0].source).toBe('entra');
    expect(rows[0].attributes.serialNumber).toBe('SN-dev-a');
    expect(rows[0].attributes.complianceState).toBe('compliant');

    // dev-b disappears from the tenant.
    const third = await withSystemContext((sql) => applyDeviceSync(sql, ORG, [renamed]));
    expect(third).toEqual({ created: 0, updated: 1, retired: 1, skippedRetirement: false });

    const after = await withSystemContext(async (sql) => (await sql.query(
      `SELECT external_id, status FROM configuration_items
        WHERE organization_id=$1 ORDER BY external_id`, [ORG])).rows);
    // Retired, not deleted.
    expect(after).toEqual([
      { external_id: 'dev-a', status: 'active' },
      { external_id: 'dev-b', status: 'retired' },
    ]);
  });

  it('does not touch manually-created CIs', async () => {
    // The reason source/external_id exist at all: a hand-entered CI must survive a sync that
    // knows nothing about it, rather than being retired as "gone from the tenant".
    await withSystemContext((sql) => sql.query(
      `INSERT INTO configuration_items (organization_id, ci_class, name, status, source)
       VALUES ($1,'device','HAND-ENTERED','active','manual')`, [ORG]));

    await withSystemContext((sql) => applyDeviceSync(sql, ORG, [device('dev-a', 'LAPTOP-A-RENAMED')]));

    const manual = await withSystemContext(async (sql) => (await sql.query(
      `SELECT status FROM configuration_items WHERE organization_id=$1 AND source='manual'`, [ORG])).rows);
    expect(manual).toEqual([{ status: 'active' }]);
  });

  it('refuses to retire the whole inventory when the tenant returns nothing', async () => {
    const stats = await withSystemContext((sql) => applyDeviceSync(sql, ORG, []));
    expect(stats.skippedRetirement).toBe(true);
    expect(stats.retired).toBe(0);

    const stillActive = await withSystemContext(async (sql) => (await sql.query(
      `SELECT count(*)::int AS n FROM configuration_items
        WHERE organization_id=$1 AND source='entra' AND status='active'`, [ORG])).rows[0].n);
    expect(stillActive).toBe(1);
  });

  it('lets only one run hold an org at a time, and releases it afterwards', async () => {
    // The race this closes: run A enumerates, run B enumerates and upserts a device A never saw,
    // then A's retirement pass finds that device in the database but not in its own older
    // enumeration and retires a live machine. A single UPDATE ... WHERE lease-is-free is the
    // whole mechanism — atomic in Postgres, so exactly one of two racing claims wins.
    await withSystemContext((sql) => sql.query(
      `INSERT INTO org_integrations
         (organization_id, provider, tenant_id, client_id, secret_ciphertext, secret_iv, secret_tag)
       VALUES ($1,'entra_graph','t','c','\\x00','\\x00','\\x00')
       ON CONFLICT (organization_id, provider) DO NOTHING`, [ORG]));

    const first = await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-a'));
    expect(first).toBe(true);

    const second = await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-b'));
    expect(second).toBe(false);

    // Someone else's lease is not ours to drop.
    await withSystemContext((sql) => releaseSyncLease(sql, ORG, 'runner-b'));
    expect(await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-c'))).toBe(false);

    await withSystemContext((sql) => releaseSyncLease(sql, ORG, 'runner-a'));
    expect(await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-d'))).toBe(true);
    await withSystemContext((sql) => releaseSyncLease(sql, ORG, 'runner-d'));
  });

  it('reclaims a lease left behind by a process that died', async () => {
    // Without expiry, one crashed sync would lock an org out of syncing forever, and the symptom
    // would be silence rather than an error.
    await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-dead'));
    await withSystemContext((sql) => sql.query(
      `UPDATE org_integrations SET sync_lease_until = now() - interval '1 minute'
        WHERE organization_id=$1 AND provider='entra_graph'`, [ORG]));

    expect(await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-live'))).toBe(true);
    await withSystemContext((sql) => releaseSyncLease(sql, ORG, 'runner-live'));
    await withSystemContext((sql) => sql.query(
      "DELETE FROM org_integrations WHERE organization_id=$1", [ORG]));
  });
});

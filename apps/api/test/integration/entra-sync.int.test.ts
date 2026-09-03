import { it, expect, beforeAll, afterAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { applyDeviceSync, claimSyncLease, releaseSyncLease, renewSyncLease } from '../../src/integrations/entra/sync.js';
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
    expect(first).toEqual({ created: 2, updated: 0, retired: 0, skippedRetirement: false, excludedPersonal: 0 });

    // Same devices again: the upsert must recognise them, not insert a second copy. This is the
    // assertion that the ON CONFLICT target lines up with the partial index.
    const renamed = device('dev-a', 'LAPTOP-A-RENAMED');
    const second = await withSystemContext((sql) =>
      applyDeviceSync(sql, ORG, [renamed, device('dev-b', 'LAPTOP-B')]));
    expect(second).toEqual({ created: 0, updated: 2, retired: 0, skippedRetirement: false, excludedPersonal: 0 });

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
    expect(third).toEqual({ created: 0, updated: 1, retired: 1, skippedRetirement: false, excludedPersonal: 0 });

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


  it('never writes a personal device to the CMDB, and retires one a prior sync left', async () => {
    // The real tenant has 11 BYOD devices among 84. This is the same transition against real
    // Postgres: a personal CI that already exists must be retired, not silently orphaned.
    await withSystemContext((sql) => sql.query(
      'DELETE FROM configuration_items WHERE organization_id=$1', [ORG]));

    const byod = { ...device('byod-1', 'Someones-iPhone'), managedDeviceOwnerType: 'personal' } as ManagedDevice;
    const corp = device('corp-1', 'LAPTOP-CORP');

    // First sync WITHOUT the exclusion in force: write the personal CI by hand, exactly as an
    // earlier build would have.
    await withSystemContext((sql) => sql.query(
      `INSERT INTO configuration_items
         (organization_id, ci_class, name, status, source, external_id)
       VALUES ($1,'device','Someones-iPhone','active','entra','byod-1')`, [ORG]));

    const stats = await withSystemContext((sql) => applyDeviceSync(sql, ORG, [corp, byod]));
    expect(stats.created).toBe(1);
    expect(stats.excludedPersonal).toBe(1);
    expect(stats.retired).toBe(1);

    const rows = await withSystemContext(async (sql) => (await sql.query(
      `SELECT external_id, status FROM configuration_items
        WHERE organization_id=$1 ORDER BY external_id`, [ORG])).rows);
    expect(rows).toEqual([
      { external_id: 'byod-1', status: 'retired' },
      { external_id: 'corp-1', status: 'active' },
    ]);

    await withSystemContext((sql) => sql.query(
      'DELETE FROM configuration_items WHERE organization_id=$1', [ORG]));
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


  it('renews a lease we hold, and refuses to renew one we lost', async () => {
    // Without renewal the lease is only a race gate for runs shorter than its expiry: a slow
    // tenant enumerates past it, a second run legitimately claims the org, and the two interleave
    // — the damage the lease was built to prevent, merely delayed by 30 minutes.
    await withSystemContext((sql) => sql.query(
      `INSERT INTO org_integrations
         (organization_id, provider, tenant_id, client_id, secret_ciphertext, secret_iv, secret_tag)
       VALUES ($1,'entra_graph','t','c','\\x00','\\x00','\\x00')
       ON CONFLICT (organization_id, provider) DO NOTHING`, [ORG]));

    expect(await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-long'))).toBe(true);
    expect(await withSystemContext((sql) => renewSyncLease(sql, ORG, 'runner-long'))).toBe(true);

    // Renewal must push the expiry into the future, not merely report success.
    const until = await withSystemContext(async (sql) => (await sql.query(
      `SELECT sync_lease_until > now() + interval '20 minutes' AS extended
         FROM org_integrations WHERE organization_id=$1 AND provider='entra_graph'`, [ORG])).rows[0].extended);
    expect(until).toBe(true);

    // Simulate losing it: the lease expires and another run takes the org.
    await withSystemContext((sql) => sql.query(
      `UPDATE org_integrations SET sync_lease_until = now() - interval '1 minute'
        WHERE organization_id=$1 AND provider='entra_graph'`, [ORG]));
    expect(await withSystemContext((sql) => claimSyncLease(sql, ORG, 'runner-new'))).toBe(true);

    // The original run must now learn it no longer holds the org — this is what stops it
    // retiring against a device list another run has already superseded.
    expect(await withSystemContext((sql) => renewSyncLease(sql, ORG, 'runner-long'))).toBe(false);

    // Leave the integration row in place: the following tests reuse it, and the last one
    // deletes it. Tearing it down here made a later test claim a lease on a row that no longer
    // existed — a fixture bug that reads exactly like a lease bug.
    await withSystemContext((sql) => releaseSyncLease(sql, ORG, 'runner-new'));
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

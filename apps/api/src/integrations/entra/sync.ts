// Orchestrates one tenant's device sync: enumerate -> upsert CIs -> retire devices that are gone.
//
// THE ORDERING IS THE SAFETY PROPERTY. Retirement runs only after a complete, successful
// enumeration and a complete set of upserts, because planRetirements cannot tell "this device is
// gone" from "we never saw this device". Anything that throws earlier propagates and no
// retirement happens at all — that is deliberate, not incidental.
import { withSystemContext, type Sql } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { buildOrgGraphClient, enumerateManagedDevices } from './graph.js';
import { mapManagedDevice, planRetirements, type ExistingCi, type ManagedDevice } from './device-map.js';
import type { SealedSecret } from './crypto.js';

export interface SyncStats {
  created: number;
  updated: number;
  retired: number;
  /** True when retirement was deliberately skipped — see the zero-device guard below. */
  skippedRetirement: boolean;
}

export interface OrgIntegrationRow {
  organization_id: string;
  tenant_id: string;
  client_id: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  key_version: number;
  cloud: string;
}

export async function applyDeviceSync(
  sql: Sql,
  orgId: string,
  devices: ManagedDevice[],
): Promise<SyncStats> {
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();

  for (const d of devices) {
    const m = mapManagedDevice(d);
    if (!m) continue; // no usable id — cannot be keyed, so it cannot be synced
    seen.add(m.externalId);
    const { rows } = await sql.query(
      `INSERT INTO configuration_items
         (organization_id, ci_class, name, status, owner, attributes, source, external_id)
       VALUES ($1,'device',$2,'active',$3,$4,'entra',$5)
       ON CONFLICT (organization_id, source, external_id)
       DO UPDATE SET name = EXCLUDED.name, owner = EXCLUDED.owner,
                     attributes = EXCLUDED.attributes, status = 'active', updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [orgId, m.name, m.owner, JSON.stringify(m.attributes), m.externalId],
    );
    if (rows[0]?.inserted) created += 1;
    else updated += 1;
  }

  const existing = (await sql.query(
    `SELECT id, external_id, status FROM configuration_items
      WHERE organization_id = $1 AND source = 'entra'`,
    [orgId],
  )).rows as ExistingCi[];

  const activeExisting = existing.filter((c) => c.status === 'active');

  // THE ZERO-DEVICE GUARD.
  //
  // An enumeration that returns nothing, for an org that already has active synced CIs, would
  // retire that customer's entire device inventory in one sweep. Sometimes that is genuinely
  // correct — every device really was unenrolled — but it is indistinguishable here from a
  // scoped-down app registration, a changed licence, or a tenant-side policy quietly returning
  // an empty set. Mass-retiring a CMDB on an ambiguous signal is not a trade worth making
  // automatically, so it stops and says so, and a human decides.
  if (devices.length === 0 && activeExisting.length > 0) {
    logger.warn(
      { org: orgId, wouldRetire: activeExisting.length },
      'entra sync: enumeration returned NO devices while active synced CIs exist — retirement skipped, review the tenant',
    );
    return { created, updated, retired: 0, skippedRetirement: true };
  }

  const toRetire = planRetirements(seen, existing);
  for (const id of toRetire) {
    // Retired, never deleted: a device that left the tenant is still part of what was once true.
    await sql.query(
      "UPDATE configuration_items SET status='retired', updated_at=now() WHERE id=$1",
      [id],
    );
  }
  return { created, updated, retired: toRetire.length, skippedRetirement: false };
}

/**
 * Enumerate one tenant's devices. Deliberately holds NO database connection: enumerating a large
 * tenant is many sequential HTTPS round-trips, and pinning a pooled connection for their duration
 * — across every configured customer in a sweep — is how a background job starves the request
 * path. The only DB touch inside is buildOrgGraphClient's brief cloud-environment lookup.
 *
 * Throws on Graph failure, which is what stops any retirement happening for that org.
 */
export async function fetchOrgDevices(row: OrgIntegrationRow): Promise<ManagedDevice[]> {
  const secret: SealedSecret = {
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
    keyVersion: row.key_version,
  };
  const client = await buildOrgGraphClient({
    tenantId: row.tenant_id, clientId: row.client_id, secret, cloud: row.cloud,
  });
  return enumerateManagedDevices(client);
}

async function recordRun(
  sql: Sql,
  orgId: string,
  startedAt: string,
  result: { stats?: SyncStats; error?: string },
): Promise<void> {
  const ok = !result.error;
  await sql.query(
    `INSERT INTO integration_sync_runs
       (organization_id, provider, started_at, finished_at, created_count, updated_count, retired_count, status, error)
     VALUES ($1,'entra_graph',$2, now(), $3,$4,$5,$6,$7)`,
    [orgId, startedAt,
      result.stats?.created ?? 0, result.stats?.updated ?? 0, result.stats?.retired ?? 0,
      ok ? 'ok' : 'error', result.error ?? null],
  );
  await sql.query(
    `UPDATE org_integrations
        SET status=$2, last_sync_at=now(), last_error=$3, last_sync_stats=$4, updated_at=now()
      WHERE organization_id=$1 AND provider='entra_graph'`,
    [orgId, ok ? 'ok' : 'error', result.error ?? null, JSON.stringify(result.stats ?? null)],
  );
}

/** Enumerate then apply, recording the run either way. Shared by the manual trigger and the job. */
async function syncOne(row: OrgIntegrationRow): Promise<SyncStats> {
  const orgId = row.organization_id;
  const startedAt = new Date().toISOString();
  try {
    const devices = await fetchOrgDevices(row);
    const stats = await withSystemContext((sql) => applyDeviceSync(sql, orgId, devices));
    await withSystemContext((sql) => recordRun(sql, orgId, startedAt, { stats }));
    return stats;
  } catch (err) {
    await withSystemContext((sql) => recordRun(sql, orgId, startedAt, { error: (err as Error).message }));
    throw err;
  }
}

/** Sync one org by id, recording the run. Used by the manual-trigger route. */
export async function runOneOrg(orgId: string): Promise<SyncStats> {
  const row = await withSystemContext((sql) => loadEnabledRow(sql, orgId));
  if (!row) throw new Error('no enabled entra_graph integration for org');
  return syncOne(row);
}

/** Every enabled integration, isolating per-org failures so one bad tenant cannot stop the rest. */
export async function runEnabledIntegrations(): Promise<void> {
  const rows = await withSystemContext(async (sql) => (await sql.query(
    `SELECT oi.organization_id, oi.tenant_id, oi.client_id,
            oi.secret_ciphertext, oi.secret_iv, oi.secret_tag, oi.key_version, o.cloud
       FROM org_integrations oi
       JOIN organizations o ON o.id = oi.organization_id
      WHERE oi.provider='entra_graph' AND oi.enabled = true`,
  )).rows as OrgIntegrationRow[]);

  for (const row of rows) {
    try {
      const stats = await syncOne(row);
      logger.info({ org: row.organization_id, ...stats }, 'entra sync ok');
    } catch (err) {
      // syncOne already recorded the failed run; a single misconfigured tenant must not
      // stop every other customer's sync.
      logger.error({ org: row.organization_id, err }, 'entra sync failed');
    }
  }
}

export async function loadEnabledRow(sql: Sql, orgId: string): Promise<OrgIntegrationRow | null> {
  const { rows } = await sql.query(
    `SELECT oi.organization_id, oi.tenant_id, oi.client_id,
            oi.secret_ciphertext, oi.secret_iv, oi.secret_tag, oi.key_version, o.cloud
       FROM org_integrations oi
       JOIN organizations o ON o.id = oi.organization_id
      WHERE oi.organization_id=$1 AND oi.provider='entra_graph' AND oi.enabled = true`,
    [orgId],
  );
  return (rows[0] as OrgIntegrationRow) ?? null;
}

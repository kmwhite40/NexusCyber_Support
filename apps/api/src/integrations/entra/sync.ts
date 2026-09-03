// Orchestrates one tenant's device sync: enumerate -> upsert CIs -> retire devices that are gone.
//
// THE ORDERING IS THE SAFETY PROPERTY. Retirement runs only after a complete, successful
// enumeration and a complete set of upserts, because planRetirements cannot tell "this device is
// gone" from "we never saw this device". Anything that throws earlier propagates and no
// retirement happens at all — that is deliberate, not incidental.
import { randomUUID } from 'node:crypto';
import { withSystemContext, type Sql } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { buildOrgGraphClient, enumerateManagedDevices } from './graph.js';
import { mapManagedDevice, planRetirements, isPersonalDevice, type ExistingCi, type ManagedDevice } from './device-map.js';
import type { SealedSecret } from './crypto.js';

export interface SyncStats {
  created: number;
  updated: number;
  retired: number;
  /** True when retirement was deliberately skipped — see the guards in applyDeviceSync. */
  skippedRetirement: boolean;
  /** Why it was skipped, in words an operator can act on. Absent when nothing was skipped. */
  skipReason?: string;
  /** BYOD devices the tenant returned and this sync deliberately did not record. */
  excludedPersonal: number;
}

/**
 * Retirement circuit-breaker.
 *
 * Below this many active synced CIs, proportion means nothing — one of two devices leaving is an
 * ordinary Tuesday, and a percentage test would refuse it forever. At or above it, retiring more
 * than RETIRE_MAX_FRACTION of the inventory in a single pass is treated as a signal about the
 * ENUMERATION rather than about the devices.
 */
const RETIRE_GUARD_FLOOR = 10;
const RETIRE_MAX_FRACTION = 0.5;

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
  let excludedPersonal = 0;
  const seen = new Set<string>();

  for (const d of devices) {
    // An employee's own phone is not the organisation's asset, and recording it here would put
    // personal hardware in the CMDB with its owner's UPN attached. Excluded devices are also
    // left OUT of `seen`, which is what makes a personal CI created by an earlier sync retire on
    // the next run rather than linger forever as a row nothing will touch again.
    if (isPersonalDevice(d)) { excludedPersonal += 1; continue; }
    const m = mapManagedDevice(d);
    if (!m) continue; // no usable id — cannot be keyed, so it cannot be synced
    seen.add(m.externalId);
    const { rows } = await sql.query(
      `INSERT INTO configuration_items
         (organization_id, ci_class, name, status, owner, attributes, source, external_id)
       VALUES ($1,'device',$2,'active',$3,$4,'entra',$5)
       -- The WHERE clause is NOT optional: ux_ci_source_external is a PARTIAL index
       -- (WHERE external_id IS NOT NULL), and Postgres refuses to infer a partial index unless
       -- the ON CONFLICT specification repeats its predicate. Without it every upsert fails with
       -- "no unique or exclusion constraint matching the ON CONFLICT specification".
       ON CONFLICT (organization_id, source, external_id) WHERE external_id IS NOT NULL
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

  // THE RETIREMENT GUARDS.
  //
  // planRetirements cannot tell "this device is gone" from "we never saw this device", so a
  // degraded enumeration and a genuinely emptied tenant look identical here. Retiring a
  // customer's device inventory on that ambiguity is the worst outcome this feature can produce,
  // so two shapes of collapse stop and ask for a human instead.
  //
  // Neither guard blocks the upserts: the devices that DID come back are real and current, and
  // recording them is never the risky half.
  const toRetire = planRetirements(seen, existing);
  const skip = retirementSkipReason(devices.length, activeExisting.length, toRetire.length);
  if (skip) {
    logger.warn({ org: orgId, activeCis: activeExisting.length, returned: devices.length, skip },
      'entra sync: retirement skipped — review the tenant and the app registration');
    return { created, updated, retired: 0, skippedRetirement: true, skipReason: skip, excludedPersonal };
  }

  for (const id of toRetire) {
    // Retired, never deleted: a device that left the tenant is still part of what was once true.
    await sql.query(
      "UPDATE configuration_items SET status='retired', updated_at=now() WHERE id=$1",
      [id],
    );
  }
  return { created, updated, retired: toRetire.length, skippedRetirement: false, excludedPersonal };
}

/**
 * Pure, so the thresholds are testable without a database.
 *
 * Returns the reason retirement must not run this pass, or null to proceed.
 */
export function retirementSkipReason(
  returned: number,
  activeCis: number,
  wouldRetire: number,
): string | null {
  if (activeCis === 0) return null; // nothing to lose

  // Total collapse. Sometimes genuinely correct, but indistinguishable from a scoped-down app
  // registration, a changed licence, or a tenant policy quietly returning an empty set.
  if (returned === 0) {
    return `the tenant returned no devices at all while ${activeCis} synced device(s) are still active`;
  }

  // Partial collapse. Five of five hundred sails past a zero check and retires the other 495 as
  // a normal, successful run — the narrowed-scope case, which is likelier than a fleet vanishing.
  if (activeCis >= RETIRE_GUARD_FLOOR && wouldRetire > activeCis * RETIRE_MAX_FRACTION) {
    return `this run would retire ${wouldRetire} of ${activeCis} active devices in one pass`;
  }
  return null;
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

/** How long a claim survives without being released. Comfortably longer than a large tenant's
 *  enumeration, short enough that a crashed process does not wedge an org for a working day. */
const LEASE_MINUTES = 30;

/**
 * Claim the right to sync this org, returning false if someone already holds it.
 *
 * One UPDATE does the whole thing, and that is the point: the WHERE clause tests the lease and
 * the SET takes it in the same statement, so two racing claims cannot both see it free. Splitting
 * this into a SELECT then an UPDATE would reintroduce exactly the race it exists to close.
 */
export async function claimSyncLease(sql: Sql, orgId: string, owner: string): Promise<boolean> {
  const { rowCount } = await sql.query(
    `UPDATE org_integrations
        SET sync_lease_owner = $2,
            sync_lease_until = now() + ($3 || ' minutes')::interval
      WHERE organization_id = $1 AND provider = 'entra_graph'
        AND (sync_lease_until IS NULL OR sync_lease_until < now())`,
    [orgId, owner, String(LEASE_MINUTES)],
  );
  return rowCount === 1;
}

/** Release a lease we hold. The owner check means a late finisher cannot free someone else's. */
export async function releaseSyncLease(sql: Sql, orgId: string, owner: string): Promise<void> {
  await sql.query(
    `UPDATE org_integrations SET sync_lease_owner = NULL, sync_lease_until = NULL
      WHERE organization_id = $1 AND provider = 'entra_graph' AND sync_lease_owner = $2`,
    [orgId, owner],
  );
}

/** Raised when another run holds the org. Not a failure — a reason to do nothing. */
export class SyncBusyError extends Error {
  constructor(orgId: string) {
    super(`a device sync is already running for organization ${orgId}`);
    this.name = 'SyncBusyError';
  }
}

/** Enumerate then apply, recording the run either way. Shared by the manual trigger and the job. */
async function syncOne(row: OrgIntegrationRow): Promise<SyncStats> {
  const orgId = row.organization_id;
  const owner = `${process.pid}:${randomUUID()}`;

  // The lease is taken BEFORE enumeration, not just around the writes: the race is between one
  // run's stale device list and another run's fresh upserts, so the window that has to be
  // exclusive is enumerate-through-retire, not the retire alone.
  const claimed = await withSystemContext((sql) => claimSyncLease(sql, orgId, owner));
  if (!claimed) throw new SyncBusyError(orgId);

  const startedAt = new Date().toISOString();
  try {
    const devices = await fetchOrgDevices(row);
    const stats = await withSystemContext((sql) => applyDeviceSync(sql, orgId, devices));
    await withSystemContext((sql) => recordRun(sql, orgId, startedAt, { stats }));
    return stats;
  } catch (err) {
    await withSystemContext((sql) => recordRun(sql, orgId, startedAt, { error: (err as Error).message }));
    throw err;
  } finally {
    // Releasing must not be able to fail the run: the lease expires on its own, and a release
    // error would replace a real sync result with a bookkeeping error.
    try {
      await withSystemContext((sql) => releaseSyncLease(sql, orgId, owner));
    } catch (err) {
      logger.error({ org: orgId, err }, 'failed to release entra sync lease; it will expire');
    }
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
      if (err instanceof SyncBusyError) {
        // Someone triggered this org by hand. Not a failure, and not worth an error row.
        logger.info({ org: row.organization_id }, 'entra sync skipped; org already syncing');
        continue;
      }
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

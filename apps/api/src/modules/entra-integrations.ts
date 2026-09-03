// Admin service for per-customer Entra/Intune device-sync integrations.
//
// The one rule this module never bends: a stored client secret goes IN and never comes back out.
// getStatus deliberately selects column-by-column rather than SELECT *, so that adding a column
// to org_integrations can never silently start leaking ciphertext to the browser.
import { withSystemContext } from '../db/pool.js';
import { config } from '../config.js';
import { sealSecret, loadMasterKey, type SealedSecret } from '../integrations/entra/crypto.js';
import { buildOrgGraphClient, type OrgEntraCreds } from '../integrations/entra/graph.js';
import { runOneOrg, SyncBusyError } from '../integrations/entra/sync.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

/** Holding a customer's directory credentials is a strictly higher bar than managing an
 *  integration's settings, so it is its own permission rather than a reuse of integration.manage. */
const PERM = 'integration.credentials.manage';

export interface ConfigureInput {
  organizationId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Create/replace an org's credentials. Always lands 'unconfigured' and does NOT enable sync:
 *  new credentials are unproven until testConnection says otherwise. */
export async function configureIntegration(actor: Principal, input: ConfigureInput) {
  authorize(actor, PERM, { organizationId: input.organizationId });
  if (!config.entraSync.encryptionKey) throw Errors.badRequest('INTEGRATION_ENC_KEY is not configured');
  const sealed = sealSecret(input.clientSecret, loadMasterKey(config.entraSync.encryptionKey));
  await withSystemContext(async (sql) => {
    await sql.query(
      `INSERT INTO org_integrations
         (organization_id, provider, tenant_id, client_id, secret_ciphertext, secret_iv, secret_tag, key_version, status, enabled)
       VALUES ($1,'entra_graph',$2,$3,$4,$5,$6,$7,'unconfigured', false)
       ON CONFLICT (organization_id, provider)
       DO UPDATE SET tenant_id=EXCLUDED.tenant_id, client_id=EXCLUDED.client_id,
                     secret_ciphertext=EXCLUDED.secret_ciphertext, secret_iv=EXCLUDED.secret_iv,
                     secret_tag=EXCLUDED.secret_tag, key_version=EXCLUDED.key_version,
                     status='unconfigured', last_error=NULL, updated_at=now()`,
      [input.organizationId, input.tenantId, input.clientId,
        sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyVersion],
    );
  });
  // tenantId and clientId are identifiers, not secrets, and an auditor needs to see WHICH app
  // registration was pointed at a customer. The secret itself never enters the audit detail.
  await audit(actor, {
    action: 'integration.entra.configured', organizationId: input.organizationId,
    resourceType: 'org_integration', resourceId: input.organizationId,
    detail: { tenantId: input.tenantId, clientId: input.clientId },
  });
  return { ok: true };
}

/** Non-secret status view for the admin UI. */
export async function getStatus(actor: Principal, organizationId: string) {
  authorize(actor, PERM, { organizationId });
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT organization_id, provider, tenant_id, client_id, enabled, status,
              last_sync_at, last_error, last_sync_stats, updated_at
         FROM org_integrations WHERE organization_id=$1 AND provider='entra_graph'`,
      [organizationId],
    );
    const runs = (await sql.query(
      `SELECT id, started_at, finished_at, created_count, updated_count, retired_count, status, error
         FROM integration_sync_runs
        WHERE organization_id=$1 AND provider='entra_graph'
        ORDER BY started_at DESC LIMIT 10`,
      [organizationId],
    )).rows;
    return { integration: rows[0] ?? null, runs };
  });
}

export async function setEnabled(actor: Principal, organizationId: string, enabled: boolean) {
  authorize(actor, PERM, { organizationId });
  await withSystemContext(async (sql) => {
    const { rowCount } = await sql.query(
      `UPDATE org_integrations SET enabled=$2, updated_at=now()
        WHERE organization_id=$1 AND provider='entra_graph'`,
      [organizationId, enabled],
    );
    if (!rowCount) throw Errors.notFound('integration not configured');
  });
  await audit(actor, {
    action: enabled ? 'integration.entra.enabled' : 'integration.entra.disabled',
    organizationId, resourceType: 'org_integration', resourceId: organizationId, detail: {},
  });
  return { ok: true };
}

/** Live connection test: acquire a token and read one device. Writes no CIs. */
export async function testConnection(actor: Principal, organizationId: string) {
  authorize(actor, PERM, { organizationId });
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT oi.tenant_id, oi.client_id, oi.secret_ciphertext, oi.secret_iv, oi.secret_tag,
              oi.key_version, o.cloud
         FROM org_integrations oi JOIN organizations o ON o.id=oi.organization_id
        WHERE oi.organization_id=$1 AND oi.provider='entra_graph'`,
      [organizationId],
    );
    if (!rows[0]) throw Errors.notFound('integration not configured');
    const r = rows[0];
    const creds: OrgEntraCreds = {
      tenantId: r.tenant_id,
      clientId: r.client_id,
      cloud: r.cloud,
      secret: {
        ciphertext: r.secret_ciphertext, iv: r.secret_iv,
        tag: r.secret_tag, keyVersion: r.key_version,
      } as SealedSecret,
    };
    try {
      const client = await buildOrgGraphClient(creds);
      await client.get('/deviceManagement/managedDevices?$top=1');
      await sql.query(
        `UPDATE org_integrations SET status='ok', last_error=NULL, updated_at=now()
          WHERE organization_id=$1 AND provider='entra_graph'`, [organizationId]);
      return { ok: true };
    } catch (err) {
      // A failed test is a RESULT, not a server error: the admin needs the message to fix the
      // app registration, and a 500 here would tell them nothing useful.
      const msg = (err as Error).message;
      await sql.query(
        `UPDATE org_integrations SET status='error', last_error=$2, updated_at=now()
          WHERE organization_id=$1 AND provider='entra_graph'`, [organizationId, msg]);
      return { ok: false, error: msg };
    }
  });
}

/** Manual on-demand sync for one org. */
export async function triggerSync(actor: Principal, organizationId: string) {
  authorize(actor, PERM, { organizationId });
  // runOneOrg only loads ENABLED integrations, so a disabled org would surface as a bare Error
  // and a 500. The state is a normal one an admin can fix, so say so as a 400.
  const enabled = await withSystemContext(async (sql) => (await sql.query(
    `SELECT enabled FROM org_integrations WHERE organization_id=$1 AND provider='entra_graph'`,
    [organizationId],
  )).rows[0]?.enabled as boolean | undefined);
  if (enabled === undefined) throw Errors.notFound('integration not configured');
  if (!enabled) throw Errors.badRequest('sync is disabled for this organization; enable it first');
  let stats;
  try {
    stats = await runOneOrg(organizationId);
  } catch (err) {
    // Already syncing is a wait-a-moment, not a failure — 409, so a double-click reads as one.
    if (err instanceof SyncBusyError) throw Errors.conflict((err as Error).message);
    // The failed run is already recorded, but the admin who clicked Sync deserves the reason on
    // screen. A bare 500 says "something broke here" when what actually happened is that the
    // customer's tenant said no — a different problem with a different fix.
    throw Errors.badGateway(`Entra sync failed: ${(err as Error).message}`);
  }
  await audit(actor, {
    action: 'integration.entra.sync', organizationId,
    resourceType: 'org_integration', resourceId: organizationId, detail: { ...stats },
  });
  return stats;
}

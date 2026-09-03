// Builds a Microsoft Graph client bound to a SINGLE customer's app registration, and enumerates
// that tenant's Intune managed devices. Reuses the existing token provider and graph client
// unchanged — per-customer isolation comes from the credentials, not from a second client stack.
import { withSystemContext } from '../../db/pool.js';
import { config } from '../../config.js';
import { createTokenProvider } from '../m365/token.js';
import { createGraphClient, type GraphClient } from '../m365/graph-client.js';
import { openSecret, loadMasterKey, type SealedSecret } from './crypto.js';
import type { ManagedDevice } from './device-map.js';

interface CloudEnv {
  login_authority: string;
  graph_endpoint: string;
}

export interface OrgEntraCreds {
  tenantId: string;
  clientId: string;
  secret: SealedSecret;
  /** Key into cloud_environments: commercial | gcc | gcchigh | azgov. */
  cloud: string;
}

/**
 * A Graph client for one customer tenant, from its stored encrypted secret.
 *
 * The secret is decrypted HERE and handed straight to the token provider — it is never returned,
 * logged, or stored in a longer-lived structure than this call.
 */
export async function buildOrgGraphClient(creds: OrgEntraCreds): Promise<GraphClient> {
  const env = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT login_authority, graph_endpoint FROM cloud_environments WHERE cloud = $1',
      [creds.cloud],
    );
    if (!rows[0]) throw new Error(`unknown cloud environment: ${creds.cloud}`);
    return rows[0] as CloudEnv;
  });

  const clientSecret = openSecret(creds.secret, loadMasterKey(config.entraSync.encryptionKey));

  const tokenProvider = createTokenProvider({
    loginAuthority: env.login_authority,
    graphEndpoint: env.graph_endpoint,
    tenantId: creds.tenantId,
    clientId: creds.clientId,
    clientSecret,
    fetchImpl: fetch as any,
    now: () => Date.now(),
  });

  return createGraphClient({
    graphEndpoint: env.graph_endpoint,
    getToken: tokenProvider.getToken,
    fetchImpl: fetch as any,
  });
}

/**
 * $select MUST list every field device-map.ts reads. Graph silently omits anything unselected —
 * a short list does not fail, it returns undefined, and every device would map with a null serial
 * number, null compliance state and null owner. Exactly the defect that hid in findUserByUpn
 * until a code review found it.
 */
const SELECT =
  '$select=azureADDeviceId,id,deviceName,userPrincipalName,operatingSystem,osVersion,'
  + 'complianceState,isEncrypted,lastSyncDateTime,manufacturer,model,serialNumber,managedDeviceOwnerType';

/** A large tenant paginates; a malformed or cyclic nextLink must not spin forever. */
const MAX_PAGES = 200;

/** Every Intune managed device, following @odata.nextLink. */
export async function enumerateManagedDevices(client: GraphClient): Promise<ManagedDevice[]> {
  const out: ManagedDevice[] = [];
  let url = `/deviceManagement/managedDevices?${SELECT}`;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      // Throwing matters: the sync must NOT treat a truncated enumeration as complete, because
      // planRetirements would then retire every device it never reached.
      throw new Error(`enumerateManagedDevices: too many pages (>${MAX_PAGES}); refusing to continue`);
    }
    const res: any = await client.get(url);
    for (const d of res?.value ?? []) out.push(d as ManagedDevice);
    const next = res?.['@odata.nextLink'];
    if (!next) break;
    url = next;
  }
  return out;
}

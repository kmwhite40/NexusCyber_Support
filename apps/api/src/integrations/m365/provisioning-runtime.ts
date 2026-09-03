// The single place the provisioning Graph clients are built. Both consumers — the service
// layer (../../modules/provisioning/index.ts) and the Cloud PC poller (../../jobs/cloudpc-poller.ts)
// — go through here, so the tenant, cloud, token provider and API-version choices cannot drift
// apart between the code that STARTS a run and the code that FINISHES it.
//
// Mirrors ./runtime.ts (the mail integration's builder): same token-provider/client-builder
// shape, memoized, with a failed build discarded so a transient outage does not poison the
// process. The differences are deliberate: the credentials come from config.provisioning
// (a separate app registration with directory-write consent, not the mail app), and the
// endpoints come from the cloud_environments row keyed by config.provisioning.cloud rather
// than config.m365.cloud.
import { config } from '../../config.js';
import { withSystemContext } from '../../db/pool.js';
import { createTokenProvider } from './token.js';
import { createGraphClient, type GraphClient } from './graph-client.js';

export interface ProvisioningGraph {
  /** v1.0 client: users, groups, licences, TAP. */
  graph: GraphClient;
  /**
   * Client for the `/deviceManagement/virtualEndpoint/*` family (Cloud PC provisioning
   * policies and Cloud PC status). Pinned to config.provisioning.cloudPcApiVersion — 'beta'
   * by default — because that family is not on v1.0 in every cloud; see the note on
   * ProvisioningConfig.cloudPcApiVersion in ../../config.ts.
   */
  cloudPc: GraphClient;
  /**
   * The tenant's Graph host. Needed verbatim by addToGroup's `@odata.id` reference, which must
   * name the same host the client authenticated against (graph.microsoft.us for GCC High).
   */
  graphEndpoint: string;
}

interface CloudEnv { login_authority: string; graph_endpoint: string }

async function loadCloudEnv(cloud: string): Promise<CloudEnv> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT login_authority, graph_endpoint FROM cloud_environments WHERE cloud = $1',
      [cloud],
    );
    if (!rows[0]) throw new Error(`unknown cloud environment: ${cloud}`);
    return rows[0] as CloudEnv;
  });
}

async function build(): Promise<ProvisioningGraph> {
  // Guarded here as well as at every entry point: nothing in this file may ever reach a live
  // tenant while the feature is off, no matter who calls it.
  if (!config.provisioning.enabled) {
    throw new Error('provisioning is not enabled');
  }
  const env = await loadCloudEnv(config.provisioning.cloud);
  // One token provider feeds both clients: same app registration, same tenant, same scope —
  // two providers would just double the token traffic and the refresh races.
  const tokenProvider = createTokenProvider({
    loginAuthority: env.login_authority,
    graphEndpoint: env.graph_endpoint,
    tenantId: config.provisioning.tenantId,
    clientId: config.provisioning.clientId,
    clientSecret: config.provisioning.clientSecret,
    fetchImpl: fetch as any,
    now: () => Date.now(),
  });
  const common = {
    graphEndpoint: env.graph_endpoint,
    getToken: tokenProvider.getToken,
    fetchImpl: fetch as any,
  };
  return {
    graph: createGraphClient(common),
    cloudPc: createGraphClient({ ...common, apiVersion: config.provisioning.cloudPcApiVersion }),
    graphEndpoint: env.graph_endpoint,
  };
}

let cached: Promise<ProvisioningGraph> | null = null;

export function getProvisioningGraph(): Promise<ProvisioningGraph> {
  if (!cached) {
    cached = build().catch((err) => {
      cached = null; // don't poison the runtime: allow a retry on the next call/tick
      throw err;
    });
  }
  return cached;
}

/** Test seam: drop the memoized clients so config/env changes take effect. */
export function __resetProvisioningGraph(): void {
  cached = null;
}

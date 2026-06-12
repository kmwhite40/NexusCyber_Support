// Lazily builds and memoizes the M365 runtime (token provider, Graph client,
// adapter) from config + the per-cloud endpoints in cloud_environments. When
// M365 is not fully configured, the console (dev) adapter is used.
import { config } from '../../config.js';
import { withSystemContext } from '../../db/pool.js';
import { createTokenProvider } from './token.js';
import { createGraphClient, type GraphClient } from './graph-client.js';
import { createGraphAdapter } from './graph-adapter.js';
import { createConsoleAdapter } from './console-adapter.js';
import type { NotificationAdapter } from './adapter.js';

interface CloudEnv {
  login_authority: string;
  graph_endpoint: string;
}

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

let adapterPromise: Promise<NotificationAdapter> | null = null;
let graphClientPromise: Promise<GraphClient | null> | null = null;

async function buildGraphClient(): Promise<GraphClient | null> {
  if (!config.m365.configured) return null;
  const env = await loadCloudEnv(config.m365.cloud);
  const tokenProvider = createTokenProvider({
    loginAuthority: env.login_authority,
    graphEndpoint: env.graph_endpoint,
    tenantId: config.m365.tenantId,
    clientId: config.m365.clientId,
    clientSecret: config.m365.clientSecret,
    fetchImpl: fetch as any,
    now: () => Date.now(),
  });
  return createGraphClient({
    graphEndpoint: env.graph_endpoint,
    getToken: tokenProvider.getToken,
    fetchImpl: fetch as any,
  });
}

/** The Graph client, or null when M365 is not configured (used by ingest/health). */
export function getGraphClient(): Promise<GraphClient | null> {
  if (!graphClientPromise) graphClientPromise = buildGraphClient();
  return graphClientPromise;
}

/** The notification adapter — Graph when configured, console otherwise. */
export function getNotificationAdapter(): Promise<NotificationAdapter> {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      const client = await getGraphClient();
      if (!client) return createConsoleAdapter();
      return createGraphAdapter({
        graphClient: client,
        serviceMailbox: config.m365.serviceMailbox,
        teamsEnabled: config.m365.teamsEnabled,
      });
    })();
  }
  return adapterPromise;
}

/** Test seam: drop memoized instances so config/env changes take effect. */
export function __resetM365Runtime(): void {
  adapterPromise = null;
  graphClientPromise = null;
}

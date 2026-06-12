// Integration health + test service backing the /integrations routes
// (docs/nexus/06 §L.8). Persists probe results and runs the live test button.
import { config } from '../config.js';
import { withSystemContext } from '../db/pool.js';
import { getGraphClient, getNotificationAdapter } from '../integrations/m365/runtime.js';
import { probe, type HealthCheck } from '../integrations/m365/health.js';
import { logger } from '../logger.js';

export interface M365HealthReport {
  configured: boolean;
  cloud: string;
  checks: HealthCheck[];
  capabilities: Record<string, unknown>;
}

async function loadCapabilities(cloud: string): Promise<Record<string, unknown>> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT capability_matrix FROM cloud_environments WHERE cloud = $1',
      [cloud],
    );
    return rows[0]?.capability_matrix ?? {};
  });
}

export async function getHealth(): Promise<M365HealthReport> {
  const client = await getGraphClient();
  const checks = await probe(client, config.m365.serviceMailbox);
  await withSystemContext(async (sql) => {
    for (const c of checks) {
      await sql.query(
        `INSERT INTO integration_health_checks (integration, check_name, status, detail)
         VALUES ('m365', $1, $2, $3)`,
        [c.check_name, c.status, JSON.stringify(c.detail)],
      );
    }
  });
  return {
    configured: config.m365.configured,
    cloud: config.m365.cloud,
    checks,
    capabilities: await loadCapabilities(config.m365.cloud),
  };
}

export interface TestResult {
  configured: boolean;
  cloud: string;
  probes: HealthCheck[];
  testEmail?: { status: string; error?: string };
}

/** Live, side-effect-safe test. Optionally sends a single test email. */
export async function runTest(opts: { sendTo?: string }): Promise<TestResult> {
  const client = await getGraphClient();
  const probes = await probe(client, config.m365.serviceMailbox);
  const result: TestResult = { configured: config.m365.configured, cloud: config.m365.cloud, probes };

  if (opts.sendTo) {
    const adapter = await getNotificationAdapter();
    const sent = await adapter.sendEmail({
      to: opts.sendTo,
      subject: 'NexusCyber M365 integration test',
      html: '<p>This is a NexusCyber integration test message.</p>',
      text: 'This is a NexusCyber integration test message.',
    });
    result.testEmail = { status: sent.status, error: sent.error };
    logger.info({ to: opts.sendTo, status: sent.status }, 'm365 integration test email');
  }
  return result;
}

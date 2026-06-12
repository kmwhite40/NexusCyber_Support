// Side-effect-safe integration probes (docs/nexus/06 §L.8). Each probe is a
// read-only Graph call; results feed integration_health_checks and the test button.
import type { GraphClient } from './graph-client.js';

export interface HealthCheck {
  check_name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: Record<string, unknown>;
}

/** Run read-only probes against the mailbox. `graphClient` is null when unconfigured. */
export async function probe(
  graphClient: GraphClient | null,
  mailbox: string,
): Promise<HealthCheck[]> {
  if (!graphClient) {
    return [
      { check_name: 'token', status: 'skipped', detail: { reason: 'M365 not configured' } },
      { check_name: 'mailbox', status: 'skipped', detail: { reason: 'M365 not configured' } },
    ];
  }
  const checks: HealthCheck[] = [];
  try {
    const user = await graphClient.get(`/users/${mailbox}?$select=id,mail,userPrincipalName`);
    checks.push({ check_name: 'token', status: 'pass', detail: {} });
    checks.push({ check_name: 'mailbox', status: 'pass', detail: { id: user?.id ?? null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({ check_name: 'token', status: 'fail', detail: { error: message } });
    checks.push({ check_name: 'mailbox', status: 'fail', detail: { error: message } });
  }
  return checks;
}

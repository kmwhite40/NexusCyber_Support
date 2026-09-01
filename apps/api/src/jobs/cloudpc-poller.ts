// Advances provisioning runs parked in `awaiting_cloudpc`. Windows 365 Cloud PC builds are
// asynchronous and typically take 30-90 minutes, so sitting in `awaiting_cloudpc` for an hour is
// a NORMAL resting state, not an error. Only a terminal Graph failure status or the elapsed
// deadline may mark a run failed — an impatient poller that fails healthy runs would have an
// admin re-provisioning an account that was about to succeed on its own.
//
// Mirrors the shape of ../jobs/retention-purge.ts and ../jobs/mail-ingest.ts: runs under
// withSystemContext (a background job has no tenant session of its own), never lets one failing
// tick take down the interval, and is a no-op unless its feature flag is on.
import { config } from '../config.js';
import { withSystemContext } from '../db/pool.js';
import { createTokenProvider } from '../integrations/m365/token.js';
import { createGraphClient, type GraphClient } from '../integrations/m365/graph-client.js';
import { getCloudPcStatus } from '../integrations/m365/provisioning-graph.js';
import { logger } from '../logger.js';

const FIVE_MIN = 5 * 60 * 1000;
export const CLOUDPC_DEADLINE_MS = 4 * 60 * 60 * 1000;

/**
 * Pure. Decides what a provisioning run parked in `awaiting_cloudpc` should transition to,
 * given the Cloud PC's current Graph status, when the run started, "now", and the deadline —
 * all passed in so the deadline branch is testable with an injected clock (no Date.now() here).
 *
 * `cloudPcStatus` is `null` for two very different reasons that must both resolve to "keep
 * waiting": the Cloud PC object hasn't appeared in Graph yet (provisioning policy processing is
 * itself async), OR the status lookup could not be completed this tick (see lookupCloudPcStatus
 * below, which collapses a transient Graph error to `null` on purpose). Either way, the correct
 * move is the same: stay parked and let the deadline — not this function guessing — decide when
 * waiting has gone on too long.
 */
export function nextRunState(
  cloudPcStatus: string | null,
  startedAt: Date,
  now: Date,
  deadlineMs: number,
): { status: 'succeeded' | 'failed' | 'awaiting_cloudpc'; error: string | null } {
  if (cloudPcStatus === 'provisioned') return { status: 'succeeded', error: null };
  if (cloudPcStatus === 'failed') {
    return { status: 'failed', error: 'Cloud PC provisioning failed in Windows 365.' };
  }
  if (now.getTime() - startedAt.getTime() > deadlineMs) {
    return { status: 'failed', error: 'Cloud PC did not finish provisioning before the deadline.' };
  }
  return { status: 'awaiting_cloudpc', error: null };
}

interface CloudEnv { login_authority: string; graph_endpoint: string }

async function loadCloudEnv(sql: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }, cloud: string): Promise<CloudEnv> {
  const { rows } = await sql.query(
    'SELECT login_authority, graph_endpoint FROM cloud_environments WHERE cloud = $1',
    [cloud],
  );
  if (!rows[0]) throw new Error(`unknown cloud environment: ${cloud}`);
  return rows[0] as CloudEnv;
}

let graphClientPromise: Promise<GraphClient> | null = null;

/**
 * Builds (and memoizes) the Graph client used to check Cloud PC status, mirroring
 * ../integrations/m365/runtime.ts's buildGraphClient — same token-provider/client-builder
 * shape, but sourced from config.provisioning instead of config.m365, and reading the
 * cloud_environments row keyed by config.provisioning.cloud rather than a hardcoded host.
 *
 * The `/deviceManagement/virtualEndpoint/*` family (which includes the cloudPCs resource
 * getCloudPcStatus reads) currently requires the Graph `beta` API version — see the comment on
 * readTenantState in ../integrations/m365/provisioning-graph.ts, which documents the same
 * requirement for the sibling /provisioningPolicies call in this family.
 */
async function buildProvisioningGraphClient(): Promise<GraphClient> {
  const env = await withSystemContext((sql) => loadCloudEnv(sql, config.provisioning.cloud));
  const tokenProvider = createTokenProvider({
    loginAuthority: env.login_authority,
    graphEndpoint: env.graph_endpoint,
    tenantId: config.provisioning.tenantId,
    clientId: config.provisioning.clientId,
    clientSecret: config.provisioning.clientSecret,
    fetchImpl: fetch as any,
    now: () => Date.now(),
  });
  return createGraphClient({
    graphEndpoint: env.graph_endpoint,
    getToken: tokenProvider.getToken,
    fetchImpl: fetch as any,
    apiVersion: 'beta',
  });
}

function getProvisioningGraphClient(): Promise<GraphClient> {
  if (!graphClientPromise) {
    graphClientPromise = buildProvisioningGraphClient().catch((err) => {
      graphClientPromise = null; // don't poison the runtime: allow a retry next tick
      throw err;
    });
  }
  return graphClientPromise;
}

/** Test seam: drop the memoized client so config/env changes take effect. */
export function __resetCloudPcPollerRuntime(): void {
  graphClientPromise = null;
}

/**
 * Looks up a run's Cloud PC status. Inert (returns null, no client, no tenant call) when the
 * feature is disabled or the run's plan carries no UPN. A transient Graph error (network,
 * throttling exhausted, tenant unreachable, ...) is caught here and ALSO collapsed to null:
 * that is what keeps a Graph outage from ever being mistaken for a terminal failure — the run
 * simply stays in `awaiting_cloudpc` and this is retried next tick, bounded only by the deadline
 * in nextRunState.
 */
async function lookupCloudPcStatus(upn: string | undefined): Promise<string | null> {
  if (!config.provisioning.enabled || !upn) return null;
  try {
    const graph = await getProvisioningGraphClient();
    return await getCloudPcStatus(graph, upn);
  } catch (err) {
    logger.warn({ err, upn }, 'cloud pc status lookup failed; leaving run parked');
    return null;
  }
}

/**
 * Records the run's outcome on its ticket as an internal (Nexus-only) note, the same shape the
 * automation engine uses for a system-authored comment (author_id NULL = system actor; see
 * performSafeAction's add_internal_note in ../modules/automation.ts). This is best-effort: a
 * failure writing the note must not prevent the run status update above it from having already
 * committed, so it is caught and logged rather than thrown.
 */
async function noteRunOutcome(
  sql: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  run: { ticket_id: string; organization_id: string },
  next: { status: 'succeeded' | 'failed'; error: string | null },
): Promise<void> {
  const body = next.status === 'succeeded'
    ? 'Provisioning complete: the Cloud PC finished building.'
    : `Provisioning failed: ${next.error ?? 'unknown error'}`;
  try {
    await sql.query(
      `INSERT INTO ticket_comments (organization_id, ticket_id, author_id, visibility, body)
       VALUES ($1,$2,NULL,'internal',$3)`,
      [run.organization_id, run.ticket_id, body],
    );
  } catch (err) {
    logger.warn({ err, ticketId: run.ticket_id }, 'failed to write provisioning outcome note');
  }
}

export function startCloudPcPoller(intervalMs = FIVE_MIN): NodeJS.Timeout | null {
  if (!config.provisioning.enabled) {
    logger.info('cloud pc poller disabled (provisioning not enabled)');
    return null;
  }

  const tick = async () => {
    try {
      await withSystemContext(async (sql) => {
        const { rows } = await sql.query(
          `SELECT id, ticket_id, organization_id, started_at, plan
             FROM provisioning_runs WHERE status = 'awaiting_cloudpc'`,
        );
        for (const run of rows) {
          // One run's failure must never abort the sweep: catch per-run so the remaining
          // parked runs still get checked this tick, and the interval itself is never at risk.
          try {
            const upn: string | undefined = run.plan?.upn;
            const status = await lookupCloudPcStatus(upn);
            // started_at is nullable in the schema, but a run can only reach awaiting_cloudpc
            // after the executor has actually started it — so this is defensive, not expected:
            // treat a missing value as "just started" rather than coercing null -> epoch, which
            // would make the deadline check below fire instantly and falsely fail a healthy run.
            const startedAt = run.started_at ? new Date(run.started_at) : new Date();
            const next = nextRunState(status, startedAt, new Date(), CLOUDPC_DEADLINE_MS);
            if (next.status === 'awaiting_cloudpc') continue;
            await sql.query(
              `UPDATE provisioning_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1`,
              [run.id, next.status, next.error],
            );
            await noteRunOutcome(sql, run, next as { status: 'succeeded' | 'failed'; error: string | null });
          } catch (err) {
            logger.error({ err, runId: run.id }, 'cloud pc poller failed to advance run');
          }
        }
      });
    } catch (err) {
      logger.error({ err }, 'cloud pc poller tick failed');
    }
  };

  return setInterval(tick, intervalMs);
}

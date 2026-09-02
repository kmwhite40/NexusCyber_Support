import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { registerRoutes } from './http/routes.js';
import { registerExtraRoutes } from './http/routes-extra.js';
import { registerIdempotency, IdempotencyStore } from './http/idempotency.js';
import { registerNotificationHandlers } from './modules/notifications.js';
import { registerAutomationHandlers } from './modules/automation.js';
import { registerCsatHandlers } from './modules/csat.js';
import { registerWebhookHandlers } from './modules/webhooks.js';
import { startSlaSweeper } from './jobs/sla-sweeper.js';
import { startCabDeadlineSweeper } from './jobs/cab-deadline-sweeper.js';
import { startConMonScheduler } from './modules/conmon.js';
import { subscribe } from './events/bus.js';
import { incCounter, renderMetrics, statusClass } from './metrics.js';
import { startMailIngest } from './jobs/mail-ingest.js';
import { startRetentionPurge } from './jobs/retention-purge.js';
import { startCloudPcPoller } from './jobs/cloudpc-poller.js';
import { startOffboardingSweeper } from './jobs/offboarding-sweeper.js';

async function main() {
  // Optional in-boundary migrations on boot (set RUN_MIGRATIONS_ON_BOOT=true). Runs
  // against the container's own DB connection — no workstation/firewall path needed.
  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true' || process.env.RUN_MIGRATIONS_ON_BOOT === '1') {
    logger.info('RUN_MIGRATIONS_ON_BOOT set — applying pending migrations before listen');
    await migrate();
  }

  // Fastify gets a logger config (not a pino instance) to keep its FastifyBaseLogger
  // typing; modules use the standalone `logger` from ./logger for their own output.
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: 1_048_576, // 1 MiB request body cap (DoS guard; attachments use presigned URLs)
    trustProxy: true,
  });

  // Tolerate empty-body requests that still carry Content-Type: application/json — browsers
  // send this on DELETE and bodyless POSTs. Fastify would otherwise throw
  // FST_ERR_CTP_EMPTY_JSON_BODY (a confusing 500). Strip the content-type when there is no
  // body so Fastify skips body parsing entirely.
  app.addHook('onRequest', async (req) => {
    const len = req.headers['content-length'];
    const ct = req.headers['content-type'];
    if ((len === undefined || len === '0') && typeof ct === 'string' && ct.includes('application/json')) {
      delete req.headers['content-type'];
    }
  });

  // Security headers (HSTS, X-Content-Type-Options, frame-deny, etc.). CSP is owned by
  // the web app; this is a JSON API so we disable helmet's CSP here.
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: false });

  // Global rate limiting (per-IP). Per-client/tenant limits layer on top in production.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1'],
  });

  // Multipart for attachment uploads (10 MiB per file; SSRF-safe streaming download).
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
  });

  // Observability: count every HTTP response by status class, and expose Prometheus metrics.
  app.addHook('onResponse', async (req, reply) => {
    incCounter('http_requests_total', { status: statusClass(reply.statusCode) }, 1, 'Total HTTP responses by status class');
    if (reply.statusCode >= 500) incCounter('http_errors_total', {}, 1, 'Total HTTP 5xx responses');
  });
  // Count domain events flowing through the bus (sla.breached, oncall.page, change.*, etc.).
  subscribe('*', (evt) => incCounter('domain_events_total', { type: evt.type }, 1, 'Domain events published'));
  incCounter('nexus_build_info', { enclave: config.enclave }, 1, 'Build/enclave info (always 1)');

  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  // Liveness + readiness probes (Kubernetes/Front Door health checks).
  app.get('/healthz', async () => ({ status: 'ok', enclave: config.enclave }));
  app.get('/readyz', async (_req, reply) => {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      return { status: 'ready' };
    } catch {
      reply.status(503);
      return { status: 'not_ready', reason: 'database_unavailable' };
    }
  });

  // Idempotency for mutating requests (replays original response for repeated keys).
  registerIdempotency(app, new IdempotencyStore());

  await registerRoutes(app);
  await registerExtraRoutes(app);

  // Wire event consumers (notification dispatcher + automation engine).
  registerNotificationHandlers();
  registerAutomationHandlers();
  registerCsatHandlers();
  // Outbound webhook dispatcher: forwards ticket.* events to per-org registered receivers.
  registerWebhookHandlers();

  // Background SLA evaluation sweep (warning/breach), idempotent.
  startSlaSweeper();

  // CAB deadline sweep: notifies the chair when a vote_deadline passes with quorum
  // unmet (notify-only; never auto-decides a change). Idempotent via a durable marker.
  startCabDeadlineSweeper();

  // Continuous Monitoring scheduler (NIST 800-137 / FedRAMP ConMon), idempotent findings.
  startConMonScheduler();

  // Inbound M365 mail -> ticket polling (no-op unless configured + enabled).
  startMailIngest();

  // Data-retention purge: delete resolved incidents/problems/changes after the window.
  if (config.retention.enabled) {
    startRetentionPurge();
    logger.info(`Retention purge enabled (${config.retention.days}d)`);
  }

  // Cloud PC provisioning poller: advances runs parked in awaiting_cloudpc (no-op unless
  // provisioning is enabled — startCloudPcPoller itself guards on config.provisioning.enabled).
  if (config.provisioning.enabled) {
    startCloudPcPoller();
    logger.info('Cloud PC poller enabled');

    // Offboarding sweep: fires approved plans at the instant HR instructed. Shares the
    // provisioning feature flag deliberately — the destructive half must not be able to run
    // without the tenant configuration the whole engine depends on.
    startOffboardingSweeper();
    logger.info('Offboarding sweeper enabled');
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`Nexus API listening on :${config.port} (enclave=${config.enclave})`);
}

main().catch((err) => {
  logger.error({ err }, 'fatal: failed to start API');
  process.exit(1);
});

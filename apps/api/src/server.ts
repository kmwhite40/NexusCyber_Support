import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/pool.js';
import { registerRoutes } from './http/routes.js';
import { registerIdempotency, IdempotencyStore } from './http/idempotency.js';
import { registerNotificationHandlers } from './modules/notifications.js';
import { registerAutomationHandlers } from './modules/automation.js';
import { startSlaSweeper } from './jobs/sla-sweeper.js';
import { startConMonScheduler } from './modules/conmon.js';

async function main() {
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

  // Wire event consumers (notification dispatcher + automation engine).
  registerNotificationHandlers();
  registerAutomationHandlers();

  // Background SLA evaluation sweep (warning/breach), idempotent.
  startSlaSweeper();

  // Continuous Monitoring scheduler (NIST 800-137 / FedRAMP ConMon), idempotent findings.
  startConMonScheduler();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`Nexus API listening on :${config.port} (enclave=${config.enclave})`);
}

main().catch((err) => {
  logger.error({ err }, 'fatal: failed to start API');
  process.exit(1);
});

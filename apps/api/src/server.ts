import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { registerRoutes } from './http/routes.js';
import { registerNotificationHandlers } from './modules/notifications.js';
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
  });

  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
  });

  await registerRoutes(app);

  // Wire event consumers (notification dispatcher).
  registerNotificationHandlers();

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

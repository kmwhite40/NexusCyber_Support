import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never log secrets/PII/CUI — redact common sensitive paths (docs/nexus/08 Q.5).
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
});

// Dev transport: renders the message to logs instead of calling Graph. Lets the
// entire notification pipeline (resolve -> render -> record) run without M365
// credentials. Selected whenever M365 is disabled or not fully configured.
import { ulid } from 'ulid';
import { logger } from '../../logger.js';
import type { NotificationAdapter } from './adapter.js';

export function createConsoleAdapter(): NotificationAdapter {
  return {
    name: 'console',
    capabilities: () => ({ email: true, teams: true }),
    async sendEmail(env) {
      logger.info({ to: env.to, subject: env.subject }, '[console] email (dev transport)');
      return { status: 'sent', providerMessageId: `console:${ulid()}` };
    },
    async sendTeams(env) {
      logger.info({ summary: env.summary }, '[console] teams (dev transport)');
      return { status: 'sent', providerMessageId: `console:${ulid()}` };
    },
  };
}

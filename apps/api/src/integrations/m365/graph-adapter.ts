// Real Graph adapter: sends email via Mail.Send from the enclave service mailbox
// (docs/nexus/06 §L.4/§L.7) and posts to Teams where enabled (§L.5). Email is
// always available; Teams is gated by config + per-tenant validation.
import { ulid } from 'ulid';
import { logger } from '../../logger.js';
import type { GraphClient } from './graph-client.js';
import type { NotificationAdapter } from './adapter.js';

export interface GraphAdapterOptions {
  graphClient: GraphClient;
  serviceMailbox: string;
  teamsEnabled: boolean;
  /** Optional Teams target for channel posting (team + channel ids). */
  teamsTarget?: { teamId: string; channelId: string };
}

// Escape user-controlled values before interpolating into HTML Teams bodies.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createGraphAdapter(opts: GraphAdapterOptions): NotificationAdapter {
  return {
    name: 'graph',
    capabilities: () => ({ email: true, teams: opts.teamsEnabled }),

    async sendEmail(env) {
      try {
        await opts.graphClient.post(`/users/${opts.serviceMailbox}/sendMail`, {
          message: {
            subject: env.subject,
            body: { contentType: 'HTML', content: env.html },
            toRecipients: [{ emailAddress: { address: env.to } }],
            from: env.fromName
              ? { emailAddress: { address: opts.serviceMailbox, name: env.fromName } }
              : undefined,
          },
          saveToSentItems: true,
        });
        // sendMail returns 202 with no body; correlate with our own id.
        return { status: 'sent', providerMessageId: `graph:${ulid()}` };
      } catch (err) {
        logger.error({ err, to: env.to }, 'graph sendMail failed');
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },

    async sendTeams(env) {
      if (!opts.teamsEnabled || !opts.teamsTarget) {
        return { status: 'failed', error: 'teams not enabled' };
      }
      try {
        const { teamId, channelId } = opts.teamsTarget;
        await opts.graphClient.post(`/teams/${teamId}/channels/${channelId}/messages`, {
          body: { contentType: 'html', content: `<b>${escapeHtml(env.summary)}</b><br/>${escapeHtml(env.text)}` },
        });
        return { status: 'sent', providerMessageId: `graph:${ulid()}` };
      } catch (err) {
        logger.error({ err }, 'graph teams post failed');
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// Periodic inbound-mail poll (docs/nexus/06 §L.4/§L.6). No-ops unless M365 is
// configured and ingestion is enabled. Mirrors the sla-sweeper scheduler shape.
import { config } from '../config.js';
import { withSystemContext } from '../db/pool.js';
import { getGraphClient } from '../integrations/m365/runtime.js';
import { fetchNewMessages, ingestMessage } from '../integrations/m365/ingest.js';
import { logger } from '../logger.js';

export function startMailIngest(intervalMs = 60_000): NodeJS.Timeout | null {
  if (!config.m365.configured || !config.m365.ingestEnabled) {
    logger.info('mail ingest disabled (M365 not configured or ingest off)');
    return null;
  }
  const tick = async () => {
    try {
      const client = await getGraphClient();
      if (!client) return;
      await withSystemContext(async (sql) => {
        const messages = await fetchNewMessages(sql, client, config.m365.serviceMailbox);
        for (const m of messages) await ingestMessage(sql, m);
        if (messages.length) logger.info({ count: messages.length }, 'inbound mail processed');
      });
    } catch (err) {
      logger.error({ err }, 'mail ingest tick failed');
    }
  };
  setTimeout(tick, 10_000); // first run shortly after boot
  return setInterval(tick, intervalMs);
}

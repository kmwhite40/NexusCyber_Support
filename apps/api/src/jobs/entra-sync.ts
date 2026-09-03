// Periodic per-customer Entra/Intune device sync. No-ops unless ENTRA_SYNC_ENABLED.
// Mirrors the mail-ingest scheduler shape.
import { config } from '../config.js';
import { runEnabledIntegrations } from '../integrations/entra/sync.js';
import { logger } from '../logger.js';

export function startEntraSync(intervalMs = config.entraSync.intervalMs): NodeJS.Timeout | null {
  // config.entraSync.enabled is already false without INTEGRATION_ENC_KEY, but say WHICH is
  // missing: "sync is off" with no reason is the state that wastes an afternoon.
  if (!config.entraSync.encryptionKey) {
    logger.info('entra device sync off (INTEGRATION_ENC_KEY not set)');
    return null;
  }
  if (!config.entraSync.enabled) {
    logger.info('entra device sync off (ENTRA_SYNC_ENABLED not true)');
    return null;
  }

  let running = false;
  const tick = async () => {
    // A sweep across several tenants can outlast the interval. Overlapping sweeps would
    // double-enumerate and race each other's upserts, so a late run is skipped, not queued.
    if (running) {
      logger.warn('entra sync still running from the previous tick; skipping this one');
      return;
    }
    running = true;
    try {
      await runEnabledIntegrations();
    } catch (err) {
      logger.error({ err }, 'entra sync tick failed');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30_000); // first run shortly after boot
  return setInterval(tick, intervalMs);
}

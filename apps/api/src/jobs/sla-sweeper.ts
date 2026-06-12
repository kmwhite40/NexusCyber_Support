// Periodic SLA evaluation (docs/nexus/04 §H.4). Runs every 60s, evaluates open
// instances, and emits sla.warning / sla.breached exactly once per instance via an
// in-memory idempotency guard (a real deployment uses durable idempotency keys).
import { withSystemContext } from '../db/pool.js';
import { evaluateState } from '../modules/sla.js';
import { publish } from '../events/bus.js';
import { logger } from '../logger.js';

const emitted = new Set<string>(); // `${instanceId}:${state}`

export function startSlaSweeper(intervalMs = 60_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      await withSystemContext(async (sql) => {
        const { rows } = await sql.query(
          `SELECT id, organization_id, ticket_id, metric, started_at, due_at, state
             FROM sla_instances WHERE state IN ('running','warning')`,
        );
        for (const inst of rows) {
          const next = evaluateState(
            { started_at: new Date(inst.started_at), due_at: new Date(inst.due_at), state: inst.state },
          );
          if (next === inst.state) continue;
          await sql.query('UPDATE sla_instances SET state=$1, breached_at=$2 WHERE id=$3', [
            next,
            next === 'breached' ? new Date() : null,
            inst.id,
          ]);
          const key = `${inst.id}:${next}`;
          if (!emitted.has(key) && (next === 'warning' || next === 'breached')) {
            emitted.add(key);
            publish(`sla.${next}`, inst.organization_id, {
              sla_instance_id: inst.id,
              ticket_id: inst.ticket_id,
              org_id: inst.organization_id,
              metric: inst.metric,
              due_at: inst.due_at,
            }, { idempotencyKey: `sla.${next}:${inst.id}:${inst.metric}` });
          }
        }
      });
    } catch (err) {
      logger.error({ err }, 'sla sweeper tick failed');
    }
  };
  // first run shortly after boot, then on interval
  setTimeout(tick, 5_000);
  return setInterval(tick, intervalMs);
}

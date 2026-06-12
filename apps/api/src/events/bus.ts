// In-process event bus (reference stand-in for Azure Service Bus + Event Grid).
// Production swaps this implementation behind the same interface; see
// docs/nexus/09 §U and ADR-005. Events carry an idempotency key and are dispatched
// asynchronously to subscribers; a real bus adds ordering, DLQ, and retention.

import { ulid } from 'ulid';
import { logger } from '../logger.js';

export interface DomainEvent<T = Record<string, unknown>> {
  event_id: string;
  type: string;
  occurred_at: string;
  organization_id: string | null;
  correlation_id?: string;
  idempotency_key: string;
  version: number;
  data: T;
}

type Handler = (evt: DomainEvent) => void | Promise<void>;

const subscribers = new Map<string, Handler[]>();
const seen = new Set<string>(); // idempotency dedupe (bounded in production)

export function subscribe(type: string, handler: Handler): void {
  const list = subscribers.get(type) ?? [];
  list.push(handler);
  subscribers.set(type, list);
}

export function publish(
  type: string,
  organizationId: string | null,
  data: Record<string, unknown>,
  opts: { idempotencyKey?: string; correlationId?: string } = {},
): DomainEvent {
  const evt: DomainEvent = {
    event_id: ulid(),
    type,
    occurred_at: new Date().toISOString(),
    organization_id: organizationId,
    correlation_id: opts.correlationId,
    idempotency_key: opts.idempotencyKey ?? `${type}:${ulid()}`,
    version: 1,
    data,
  };

  if (seen.has(evt.idempotency_key)) {
    logger.debug({ key: evt.idempotency_key }, 'event deduped');
    return evt;
  }
  seen.add(evt.idempotency_key);

  const handlers = [...(subscribers.get(type) ?? []), ...(subscribers.get('*') ?? [])];
  for (const h of handlers) {
    Promise.resolve()
      .then(() => h(evt))
      .catch((err) => logger.error({ err, type }, 'event handler failed (would DLQ)'));
  }
  logger.info({ type, org: organizationId }, 'event published');
  return evt;
}

// Idempotency-Key support for mutating requests (docs/nexus/09 §T.1). In-memory store
// with TTL (a production deployment uses a shared store, e.g. Redis). Replays the
// original response for a repeated (method, path, key) within the window.
import type { FastifyInstance } from 'fastify';

export interface StoredResponse {
  status: number;
  payload: string;
}

export class IdempotencyStore {
  private map = new Map<string, { exp: number; res: StoredResponse }>();
  constructor(private ttlMs = 600_000, private now: () => number = () => Date.now()) {}

  get(key: string): StoredResponse | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.res;
  }

  set(key: string, res: StoredResponse): void {
    this.map.set(key, { exp: this.now() + this.ttlMs, res });
  }

  get size(): number {
    return this.map.size;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerIdempotency(app: FastifyInstance, store: IdempotencyStore): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const key = req.headers['idempotency-key'];
    if (!key || typeof key !== 'string') return;
    const cacheKey = `${req.method}:${req.url}:${key}`;
    (req as unknown as { _idemKey?: string })._idemKey = cacheKey;
    const hit = store.get(cacheKey);
    if (hit) {
      reply.header('Idempotent-Replay', 'true').status(hit.status);
      reply.send(hit.payload ? JSON.parse(hit.payload) : undefined);
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const cacheKey = (req as unknown as { _idemKey?: string })._idemKey;
    if (cacheKey && reply.statusCode >= 200 && reply.statusCode < 300) {
      store.set(cacheKey, { status: reply.statusCode, payload: typeof payload === 'string' ? payload : '' });
    }
    return payload;
  });
}

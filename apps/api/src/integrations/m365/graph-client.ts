// Microsoft Graph v1.0 HTTP client. Injects the bearer token, prefixes the
// per-cloud base URL, and honors 429/503 + Retry-After with jittered backoff
// (docs/nexus/06 §L.6). Audit logging of call class is done by callers; this
// layer never logs request/response bodies.
import { logger } from '../../logger.js';
import type { FetchLike } from './token.js';

export class GraphError extends Error {
  constructor(public status: number, public body: string) {
    super(`Graph request failed: ${status}`);
    this.name = 'GraphError';
  }
}

type FetchWithHeaders = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface GraphClientOptions {
  graphEndpoint: string;
  getToken: () => Promise<string>;
  fetchImpl: FetchWithHeaders | FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  apiVersion?: 'v1.0' | 'beta';
}

export interface GraphClient {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
  patch: (path: string, body: unknown) => Promise<any>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createGraphClient(opts: GraphClientOptions): GraphClient {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 4;
  const fetchImpl = opts.fetchImpl as FetchWithHeaders;

  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<any> {
    const version = opts.apiVersion ?? 'v1.0';
    const url = path.startsWith('http') ? path : `${opts.graphEndpoint}/${version}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await opts.getToken();
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500, 8000) + Math.floor(attempt * 137); // jittered backoff
        logger.warn({ status: res.status, attempt, waitMs }, 'graph throttled; backing off');
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new GraphError(res.status, await res.text());
      if (res.status === 202 || res.status === 204) return null;
      return res.json();
    }
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}

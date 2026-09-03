import { describe, it, expect, vi } from 'vitest';
import { createGraphClient, GraphError } from '../src/integrations/m365/graph-client.js';

function res(status: number, body: any, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const deps = (fetchImpl: any) => ({
  graphEndpoint: 'https://graph.microsoft.com',
  getToken: async () => 'tok',
  fetchImpl,
  sleep: vi.fn(async () => {}),
});

describe('createGraphClient', () => {
  it('GETs v1.0 with a bearer token and returns json', async () => {
    const fetchImpl = vi.fn(async () => res(200, { id: 'u1' }));
    const c = createGraphClient(deps(fetchImpl));
    const out = await c.get('/users/svc@x');
    expect(out).toEqual({ id: 'u1' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/users/svc@x');
    expect((fetchImpl.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok');
  });

  it('retries on 429 honoring Retry-After then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, 'slow down', { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const d = deps(fetchImpl);
    const c = createGraphClient(d);
    const out = await c.get('/me');
    expect(out).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(2000);
  });

  it('returns null for 202/204 (no body)', async () => {
    const fetchImpl = vi.fn(async () => res(202, ''));
    const c = createGraphClient(deps(fetchImpl));
    expect(await c.post('/users/x/sendMail', {})).toBeNull();
  });

  it('throws GraphError on a non-retryable 4xx', async () => {
    const fetchImpl = vi.fn(async () => res(403, { error: 'forbidden' }));
    const c = createGraphClient(deps(fetchImpl));
    await expect(c.get('/x')).rejects.toBeInstanceOf(GraphError);
  });
});

// Offboarding needs DELETE: removing a group membership is DELETE /groups/{g}/members/{u}/$ref,
// which has no PATCH or POST equivalent. The client carried only GET/POST/PATCH.
describe('createGraphClient — DELETE', () => {
  it('issues a DELETE with the bearer token and no body', async () => {
    const fetchImpl = vi.fn(async () => res(204, null));
    const c = createGraphClient(deps(fetchImpl));
    await c.del('/groups/g-1/members/u-1/$ref');
    const [url, init] = fetchImpl.mock.calls[0] as [string, any];
    expect(url).toBe('https://graph.microsoft.com/v1.0/groups/g-1/members/u-1/$ref');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('returns null on 204 rather than trying to parse an empty body', async () => {
    const fetchImpl = vi.fn(async () => res(204, null));
    const c = createGraphClient(deps(fetchImpl));
    await expect(c.del('/groups/g-1/members/u-1/$ref')).resolves.toBeNull();
  });

  it('throws GraphError on a failed delete instead of resolving silently', async () => {
    const fetchImpl = vi.fn(async () => res(404, { error: { code: 'Request_ResourceNotFound' } }));
    const c = createGraphClient(deps(fetchImpl));
    await expect(c.del('/groups/g-1/members/u-1/$ref')).rejects.toBeInstanceOf(GraphError);
  });
});

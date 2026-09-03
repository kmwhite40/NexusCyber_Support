import { describe, it, expect } from 'vitest';
import { createGraphClient } from '../src/integrations/m365/graph-client.js';

function fakeFetch(seen: { url: string; method: string }[]) {
  return async (url: string, init: Record<string, unknown>) => {
    seen.push({ url, method: String(init.method) });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => '' };
  };
}

describe('graph client', () => {
  it('issues PATCH requests', async () => {
    const seen: { url: string; method: string }[] = [];
    const c = createGraphClient({ graphEndpoint: 'https://graph.microsoft.us', getToken: async () => 't', fetchImpl: fakeFetch(seen) as never });
    await c.patch('/users/abc', { jobTitle: 'Analyst' });
    expect(seen[0].method).toBe('PATCH');
    expect(seen[0].url).toBe('https://graph.microsoft.us/v1.0/users/abc');
  });

  it('honours an explicit apiVersion', async () => {
    const seen: { url: string; method: string }[] = [];
    const c = createGraphClient({ graphEndpoint: 'https://graph.microsoft.us', getToken: async () => 't', fetchImpl: fakeFetch(seen) as never, apiVersion: 'beta' });
    await c.get('/deviceManagement/virtualEndpoint/provisioningPolicies');
    expect(seen[0].url).toContain('/beta/deviceManagement');
  });
});

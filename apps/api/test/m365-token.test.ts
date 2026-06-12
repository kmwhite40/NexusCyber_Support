import { describe, it, expect, vi } from 'vitest';
import { createTokenProvider } from '../src/integrations/m365/token.js';

function okToken(token: string, expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
    text: async () => '',
  };
}

const base = {
  loginAuthority: 'https://login.microsoftonline.com',
  graphEndpoint: 'https://graph.microsoft.com',
  tenantId: 't1',
  clientId: 'c1',
  clientSecret: 's1',
};

describe('createTokenProvider', () => {
  it('fetches once and caches while valid', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => okToken('tok1'));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => now });
    expect(await p.getToken()).toBe('tok1');
    now = 1000;
    expect(await p.getToken()).toBe('tok1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes after expiry', async () => {
    let now = 0;
    let n = 0;
    const fetchImpl = vi.fn(async () => okToken(`tok${++n}`, 3600));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => now });
    expect(await p.getToken()).toBe('tok1');
    now = 3_600_000; // past expiry (minus the 60s safety margin)
    expect(await p.getToken()).toBe('tok2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requests the .default scope for the graph endpoint', async () => {
    const fetchImpl = vi.fn(async () => okToken('tok1'));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => 0 });
    await p.getToken();
    const body = String((fetchImpl.mock.calls[0][1] as any).body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain(encodeURIComponent('https://graph.microsoft.com/.default'));
  });

  it('throws on a non-ok token response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'bad' }));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => 0 });
    await expect(p.getToken()).rejects.toThrow(/401/);
  });
});

// OAuth2 client-credentials token provider for Microsoft Graph (app-only).
// Endpoints are injected (sourced from cloud_environments) so the same code
// serves commercial, GCC, and GCC High. Tokens are cached in-memory until
// shortly before expiry.

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface TokenProviderOptions {
  loginAuthority: string; // e.g. https://login.microsoftonline.com
  graphEndpoint: string; // e.g. https://graph.microsoft.com
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: FetchLike;
  now: () => number; // injectable clock (ms epoch)
}

export interface TokenProvider {
  getToken: () => Promise<string>;
}

const SAFETY_MARGIN_MS = 60_000;

export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async getToken(): Promise<string> {
      const now = opts.now();
      if (cached && cached.expiresAt - SAFETY_MARGIN_MS > now) return cached.token;

      const url = `${opts.loginAuthority}/${opts.tenantId}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: `${opts.graphEndpoint}/.default`,
      }).toString();

      const res = await opts.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) {
        throw new Error(`M365 token request failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      cached = { token: data.access_token, expiresAt: now + Number(data.expires_in) * 1000 };
      return cached.token;
    },
  };
}

// Entra ID (Azure Government) OIDC for the agent plane.
//
// Standards-only implementation (jose + global fetch) — Authorization Code + PKCE.
// This validates the Entra id_token (issuer / audience / signature / nonce) and hands
// a normalized identity to accounts.loginOrProvisionAgentOidc, which mints the SAME
// local session JWT as every other login path. RBAC/ABAC/RLS are unchanged.
//
// Azure Gov endpoints come from OIDC discovery against config.oidc.authority
// (https://login.microsoftonline.us/{tenant}/v2.0) — NOT the commercial .com host.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { Errors } from '../errors.js';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let discoveryCache: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function discover(): Promise<Discovery> {
  if (discoveryCache && jwks) return discoveryCache;
  const url = `${config.oidc.authority.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${url}`);
  const d = (await res.json()) as Record<string, string>;
  discoveryCache = {
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
    issuer: d.issuer,
  };
  jwks = createRemoteJWKSet(new URL(discoveryCache.jwks_uri));
  return discoveryCache;
}

function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Opaque random value for state / nonce. */
export function randomToken(): string {
  return base64url(randomBytes(24));
}

/** PKCE verifier + S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function buildAuthUrl(p: {
  state: string;
  nonce: string;
  challenge: string;
}): Promise<string> {
  const d = await discover();
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('client_id', config.oidc.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', config.oidc.redirectUri);
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface OidcIdentity {
  /** Entra object id (oid) — stable per user per tenant. */
  oid: string;
  email: string;
  displayName: string | null;
  /** App roles from the token's `roles` claim (e.g. Anchor.SecurityAnalyst). */
  appRoles: string[];
}

/** Exchange the auth code for tokens and validate the id_token. */
export async function exchangeAndValidate(
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<OidcIdentity> {
  const d = await discover();
  const body = new URLSearchParams({
    client_id: config.oidc.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.oidc.redirectUri,
    code_verifier: verifier,
  });
  if (config.oidc.clientSecret) body.set('client_secret', config.oidc.clientSecret);

  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw Errors.unauthorized('OIDC token exchange failed');
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw Errors.unauthorized('OIDC response missing id_token');

  // Verify signature against the tenant JWKS, and pin issuer + audience.
  const { payload } = await jwtVerify(tok.id_token, jwks!, {
    issuer: d.issuer,
    audience: config.oidc.clientId,
  });
  if (expectedNonce && (payload as JWTPayload).nonce !== expectedNonce) {
    throw Errors.unauthorized('OIDC nonce mismatch');
  }

  const p = payload as JWTPayload & {
    oid?: string;
    preferred_username?: string;
    email?: string;
    name?: string;
    roles?: unknown;
  };
  const email = String(p.preferred_username ?? p.email ?? '').toLowerCase();
  const oid = String(p.oid ?? p.sub ?? '');
  if (!oid) throw Errors.unauthorized('OIDC token missing subject');
  const appRoles = Array.isArray(p.roles) ? p.roles.map(String) : [];
  return { oid, email, displayName: typeof p.name === 'string' ? p.name : null, appRoles };
}

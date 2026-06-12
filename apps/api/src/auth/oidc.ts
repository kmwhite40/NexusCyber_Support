// Entra ID (Azure Government) OIDC.
//
// Standards-only implementation (jose + global fetch) — Authorization Code + PKCE.
// Validates the Entra id_token (issuer / audience / signature / nonce) and hands a
// normalized identity to accounts.* which mints the SAME local session JWT as every
// other login path. RBAC/ABAC/RLS are unchanged.
//
// Two modes:
//   - AGENT (single-tenant): config.oidc.authority = .../{tenant}/v2.0, issuer is fixed.
//   - CUSTOMER (multitenant): config.oidcCustomer.authority = .../organizations/v2.0;
//     tokens arrive from many tenants, so the issuer/JWKS are resolved per-tenant from
//     the token's `tid`, and the tid is allow-listed downstream (organizations table).
//
// Azure Gov endpoints (login.microsoftonline.us) come from OIDC discovery — NOT .com.

import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTPayload } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { Errors } from '../errors.js';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

type Jwks = ReturnType<typeof createRemoteJWKSet>;

// Discovery + JWKS caches, keyed by authority / tenant so agent and customer modes
// (and each customer tenant) are isolated.
const discoveryByAuthority = new Map<string, Discovery>();
const jwksByAuthority = new Map<string, Jwks>();
const jwksByTenant = new Map<string, Jwks>();

async function discoverAuthority(authority: string): Promise<Discovery> {
  const cached = discoveryByAuthority.get(authority);
  if (cached) return cached;
  const url = `${authority.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${url}`);
  const d = (await res.json()) as Record<string, string>;
  const disc: Discovery = {
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
    issuer: d.issuer,
  };
  discoveryByAuthority.set(authority, disc);
  jwksByAuthority.set(authority, createRemoteJWKSet(new URL(disc.jwks_uri)));
  return disc;
}

/** Per-tenant JWKS for multitenant validation (keys live at {base}/{tid}/discovery/v2.0/keys). */
function jwksForTenant(loginBase: string, tid: string): Jwks {
  const key = `${loginBase}|${tid}`;
  let j = jwksByTenant.get(key);
  if (!j) {
    j = createRemoteJWKSet(new URL(`${loginBase}/${tid}/discovery/v2.0/keys`));
    jwksByTenant.set(key, j);
  }
  return j;
}

/** Scheme+host of an authority URL, e.g. https://login.microsoftonline.us. */
function loginBaseFrom(authority: string): string {
  const u = new URL(authority);
  return `${u.protocol}//${u.host}`;
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

interface AuthUrlParams {
  state: string;
  nonce: string;
  challenge: string;
}

async function buildAuthorizeUrl(
  authority: string,
  clientId: string,
  redirectUri: string,
  p: AuthUrlParams,
): Promise<string> {
  const d = await discoverAuthority(authority);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function exchangeCode(
  authority: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<string> {
  const d = await discoverAuthority(authority);
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw Errors.unauthorized('OIDC token exchange failed');
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw Errors.unauthorized('OIDC response missing id_token');
  return tok.id_token;
}

// ---------------- AGENT (single-tenant) ----------------

export interface OidcIdentity {
  /** Entra object id (oid) — stable per user per tenant. */
  oid: string;
  email: string;
  displayName: string | null;
  /** App roles from the token's `roles` claim (e.g. Anchor.SecurityAnalyst). */
  appRoles: string[];
}

export async function buildAuthUrl(p: AuthUrlParams): Promise<string> {
  return buildAuthorizeUrl(config.oidc.authority, config.oidc.clientId, config.oidc.redirectUri, p);
}

export async function exchangeAndValidate(
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<OidcIdentity> {
  const d = await discoverAuthority(config.oidc.authority);
  const idToken = await exchangeCode(
    config.oidc.authority,
    config.oidc.clientId,
    config.oidc.clientSecret,
    config.oidc.redirectUri,
    code,
    verifier,
  );
  const jwks = jwksByAuthority.get(config.oidc.authority)!;
  const { payload } = await jwtVerify(idToken, jwks, {
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

// ---------------- CUSTOMER (multitenant) ----------------

export interface OidcCustomerIdentity {
  /** Home tenant id of the customer user — the allow-list key. */
  tid: string;
  oid: string;
  email: string;
  displayName: string | null;
}

export async function buildCustomerAuthUrl(p: AuthUrlParams): Promise<string> {
  return buildAuthorizeUrl(
    config.oidcCustomer.authority,
    config.oidcCustomer.clientId,
    config.oidcCustomer.redirectUri,
    p,
  );
}

export async function exchangeAndValidateCustomer(
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<OidcCustomerIdentity> {
  const idToken = await exchangeCode(
    config.oidcCustomer.authority,
    config.oidcCustomer.clientId,
    config.oidcCustomer.clientSecret,
    config.oidcCustomer.redirectUri,
    code,
    verifier,
  );
  // Read the tenant id from the (still-unverified) token to pick the right issuer/keys,
  // then fully verify the signature against THAT tenant's JWKS and pinned issuer.
  const pre = decodeJwt(idToken) as JWTPayload & { tid?: string };
  const tid = String(pre.tid ?? '');
  if (!tid) throw Errors.unauthorized('OIDC token missing tenant id (tid)');
  const loginBase = loginBaseFrom(config.oidcCustomer.authority);
  const issuer = `${loginBase}/${tid}/v2.0`;
  const { payload } = await jwtVerify(idToken, jwksForTenant(loginBase, tid), {
    issuer,
    audience: config.oidcCustomer.clientId,
  });
  if (expectedNonce && (payload as JWTPayload).nonce !== expectedNonce) {
    throw Errors.unauthorized('OIDC nonce mismatch');
  }
  const p = payload as JWTPayload & {
    oid?: string;
    preferred_username?: string;
    email?: string;
    name?: string;
  };
  const email = String(p.preferred_username ?? p.email ?? '').toLowerCase();
  const oid = String(p.oid ?? p.sub ?? '');
  if (!oid) throw Errors.unauthorized('OIDC token missing subject');
  return { tid, oid, email, displayName: typeof p.name === 'string' ? p.name : null };
}

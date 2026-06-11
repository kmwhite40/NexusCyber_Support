// Session issuance & validation.
//
// In PRODUCTION this module is replaced by real OIDC validation against:
//   - Nexus Entra ID (agents) — single-tenant app, per enclave
//   - per-customer IdPs (customers) — issuer/audience/signature/tenant pinning
// (docs/nexus/02 §E.7, §E.10). The dev path below issues local signed JWTs so the
// reference app is runnable without an external IdP. It is gated to non-production.

import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { SessionClaims } from '../types.js';
import { Errors } from '../errors.js';

const TTL_SECONDS = 60 * 60; // short-lived session (docs/nexus/02 §E.2)

export function issueSession(claims: Omit<SessionClaims, 'iat' | 'exp'>): string {
  return jwt.sign(claims, config.sessionSigningKey, {
    algorithm: 'HS256',
    expiresIn: TTL_SECONDS,
    issuer: `nexus-${config.enclave}`,
    audience: 'nexus-api',
  });
}

export function validateSession(token: string): SessionClaims {
  try {
    return jwt.verify(token, config.sessionSigningKey, {
      algorithms: ['HS256'],
      issuer: `nexus-${config.enclave}`,
      audience: 'nexus-api',
    }) as SessionClaims;
  } catch {
    throw Errors.unauthorized('Invalid or expired session');
  }
}

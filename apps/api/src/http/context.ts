// Extracts and validates the session, attaching a resolved Principal to the request.
import type { FastifyRequest } from 'fastify';
import { validateSession } from '../auth/session.js';
import { loadPrincipal } from '../auth/principal.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // Cookie fallback (httpOnly session in browser).
  const cookie = req.headers.cookie;
  const match = cookie?.match(/(?:^|;\s*)nexus_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function requirePrincipal(req: FastifyRequest): Promise<Principal> {
  if (req.principal) return req.principal;
  const token = extractToken(req);
  if (!token) throw Errors.unauthorized('no session');
  const claims = validateSession(token);
  const principal = await loadPrincipal(claims);
  req.principal = principal;
  return principal;
}

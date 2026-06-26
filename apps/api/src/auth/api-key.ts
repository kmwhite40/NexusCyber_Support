// Machine-to-machine API keys for non-interactive integrations (e.g. the Anchor sync).
// A presented token has the shape `ak_<keyId>_<secret>`; only a scrypt hash of the secret
// is stored (auth/password.ts format). A valid key resolves to a NEXUS-plane Principal
// scoped to exactly ONE organization, carrying a bounded set of ticket permission verbs.
// The lookup runs in the system (owner) context — like local login — because there is no
// org context yet at authentication time; RLS still guards the management endpoints.
import { randomBytes } from 'node:crypto';
import { withSystemContext } from '../db/pool.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Principal } from '../types.js';

// Verbs an API key is permitted to hold. Keys are integration identities, not admins:
// they can move tickets, never manage users/billing/elevation/etc.
export const ALLOWED_KEY_SCOPES = [
  'ticket.create',
  'ticket.read.organization',
  'ticket.update',
  'ticket.comment',
  'ticket.assign',
] as const;

export const DEFAULT_KEY_SCOPES: string[] = [
  'ticket.create',
  'ticket.read.organization',
  'ticket.update',
  'ticket.comment',
];

/** Intersect requested scopes with the allow-list; empty/invalid falls back to defaults. */
export function sanitizeScopes(scopes?: string[]): string[] {
  if (!scopes?.length) return [...DEFAULT_KEY_SCOPES];
  const allowed = new Set<string>(ALLOWED_KEY_SCOPES);
  const picked = [...new Set(scopes)].filter((s) => allowed.has(s));
  return picked.length ? picked : [...DEFAULT_KEY_SCOPES];
}

export function formatApiKey(keyId: string, secret: string): string {
  return `ak_${keyId}_${secret}`;
}

/** Split a presented token into its public id and secret. Tolerates separators in the
 *  secret by splitting only on the first underscore after the `ak_` prefix. */
export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  if (!raw?.startsWith('ak_')) return null;
  const rest = raw.slice(3);
  const idx = rest.indexOf('_');
  if (idx <= 0) return null;
  const keyId = rest.slice(0, idx);
  const secret = rest.slice(idx + 1);
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

/** Is this Authorization value an API key (vs. a JWT session)? */
export function looksLikeApiKey(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && raw.startsWith('ak_');
}

export interface GeneratedKey {
  keyId: string;
  secret: string;
  token: string;
  hash: string;
}

/** Mint a fresh key. The plaintext `token` is shown to the caller exactly once; only
 *  `hash` is persisted. Hex (no underscores) keeps the token cleanly parseable. */
export async function generateApiKey(): Promise<GeneratedKey> {
  const keyId = randomBytes(8).toString('hex'); // 16-char public handle
  const secret = randomBytes(24).toString('hex'); // 48-char secret
  const hash = await hashPassword(secret);
  return { keyId, secret, token: formatApiKey(keyId, secret), hash };
}

interface ApiKeyRow {
  id: string;
  organization_id: string;
  key_id: string;
  key_hash: string;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/** Build the scoped service Principal a valid key authenticates as. */
export function buildKeyPrincipal(row: ApiKeyRow): Principal {
  return {
    id: row.id,
    plane: 'nexus',
    email: `apikey:${row.key_id}`,
    displayName: row.name,
    organizationId: null,
    roles: [],
    permissions: row.scopes,
    assignedOrgs: [row.organization_id], // scoped to this one org (not all-orgs)
    allOrgs: false,
    elevated: false,
  };
}

/**
 * Validate a presented token and resolve its Principal, or null if invalid/revoked/expired.
 * On success, stamps last_used_at. Unknown key ids return early (no hash) — key ids are
 * random and non-enumerable, so this is not a meaningful oracle.
 */
export async function authenticateApiKey(raw: string): Promise<Principal | null> {
  const parsed = parseApiKey(raw);
  if (!parsed) return null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, organization_id, key_id, key_hash, name, scopes, expires_at, revoked_at
         FROM api_keys WHERE key_id = $1`,
      [parsed.keyId],
    );
    const row = rows[0] as ApiKeyRow | undefined;
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    const ok = await verifyPassword(parsed.secret, row.key_hash);
    if (!ok) return null;
    await sql.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
    return buildKeyPrincipal(row);
  });
}

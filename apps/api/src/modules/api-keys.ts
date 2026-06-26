// Management of per-organization M2M API keys (docs/nexus/09 §U). Create/list/revoke run in
// the caller's RLS org-context, so a tenant only ever sees its own keys. The secret is
// returned exactly once, on creation; thereafter only metadata is visible.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { generateApiKey, sanitizeScopes } from '../auth/api-key.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

/** Resolve the org the operation targets: customers act on their own org; nexus callers
 *  must name one (and must be in scope for it — the PDP enforces that next). */
function resolveOrgId(actor: Principal, organizationId?: string): string {
  const orgId = actor.plane === 'customer' ? actor.organizationId : organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  return orgId;
}

export interface CreateApiKeyInput {
  organizationId?: string;
  name: string;
  scopes?: string[];
  expiresAt?: string;
}

export async function createApiKey(actor: Principal, input: CreateApiKeyInput) {
  const orgId = resolveOrgId(actor, input.organizationId);
  authorize(actor, 'integration.manage', { organizationId: orgId });
  const scopes = sanitizeScopes(input.scopes);
  const key = await generateApiKey();

  const row = await withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO api_keys (organization_id, key_id, key_hash, name, scopes, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, organization_id, key_id, name, scopes, created_at, expires_at`,
      [orgId, key.keyId, key.hash, input.name, scopes, actor.id, input.expiresAt ?? null],
    );
    return rows[0];
  });

  await audit(actor, {
    action: 'integration.api_key.create',
    organizationId: orgId,
    resourceType: 'api_key',
    resourceId: row.id,
    detail: { name: input.name, scopes },
  });

  // `token` is shown ONCE — the caller must store it now; it cannot be recovered.
  return { ...row, token: key.token };
}

export async function listApiKeys(actor: Principal, organizationId?: string) {
  const orgId = resolveOrgId(actor, organizationId);
  authorize(actor, 'integration.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, organization_id, key_id, name, scopes, created_at, last_used_at, expires_at, revoked_at
         FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return rows;
  });
}

export async function revokeApiKey(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    // RLS already scopes the row to the caller's org; verify it exists for a clean 404.
    const existing = (await sql.query('SELECT organization_id FROM api_keys WHERE id = $1', [id])).rows[0];
    if (!existing) throw Errors.notFound('api key not found');
    authorize(actor, 'integration.manage', { organizationId: existing.organization_id });
    await sql.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    await audit(actor, {
      action: 'integration.api_key.revoke',
      organizationId: existing.organization_id,
      resourceType: 'api_key',
      resourceId: id,
    });
    return { id, revoked: true };
  });
}

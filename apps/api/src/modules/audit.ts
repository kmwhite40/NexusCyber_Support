// Pervasive, hash-chained audit logging (docs/nexus/08 §Q.5, ADR-013).
// Append-only; each row links to the previous via a hash chain for tamper-evidence.
import { createHash } from 'node:crypto';
import { withSystemContext } from '../db/pool.js';
import type { Principal } from '../types.js';

export interface AuditInput {
  action: string;
  organizationId?: string | null;
  resourceType?: string;
  resourceId?: string | null;
  scope?: string;
  detail?: Record<string, unknown>;
}

export async function audit(actor: Principal | null, input: AuditInput): Promise<void> {
  await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT row_hash FROM audit_logs ORDER BY created_at DESC LIMIT 1',
    );
    const prevHash: string | null = rows[0]?.row_hash ?? null;

    const payload = JSON.stringify({
      actor: actor?.id ?? null,
      action: input.action,
      resource: input.resourceId ?? null,
      detail: input.detail ?? {},
      at: new Date().toISOString(),
    });
    const rowHash = createHash('sha256')
      .update((prevHash ?? '') + payload)
      .digest('hex');

    await sql.query(
      `INSERT INTO audit_logs
         (organization_id, actor_id, actor_plane, action, resource_type, resource_id, scope, detail, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.organizationId ?? actor?.organizationId ?? null,
        actor?.id ?? null,
        actor?.plane ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.scope ?? null,
        input.detail ?? {},
        prevHash,
        rowHash,
      ],
    );
  });
}

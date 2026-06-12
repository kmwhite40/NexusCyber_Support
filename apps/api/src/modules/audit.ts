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
      'SELECT row_hash FROM audit_logs ORDER BY seq DESC LIMIT 1',
    );
    const prevHash: string | null = rows[0]?.row_hash ?? null;

    // Capture the timestamp once and persist it into created_at so the stored row is
    // self-consistent with its hash — this is what makes verifyChain() work over real data.
    const at = new Date().toISOString();
    const payload = JSON.stringify({
      actor: actor?.id ?? null,
      action: input.action,
      resource: input.resourceId ?? null,
      detail: input.detail ?? {},
      at,
    });
    const rowHash = createHash('sha256')
      .update((prevHash ?? '') + payload)
      .digest('hex');

    await sql.query(
      `INSERT INTO audit_logs
         (organization_id, actor_id, actor_plane, action, resource_type, resource_id, scope, detail, prev_hash, row_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
        at,
      ],
    );
  });
}

// --- Hash-chain integrity verification (docs/nexus/08 §Q.5, ADR-013) ---

export interface AuditRow {
  actor_id: string | null;
  action: string;
  resource_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  prev_hash: string | null;
  row_hash: string;
}

export interface ChainResult {
  ok: boolean;
  checked: number;
  brokenAt: number | null; // index of first divergence, or null
}

/** Recompute the hash chain over ordered rows; report the first divergence. Pure. */
export function verifyChain(rows: AuditRow[]): ChainResult {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const payload = JSON.stringify({
      actor: row.actor_id ?? null,
      action: row.action,
      resource: row.resource_id ?? null,
      detail: row.detail ?? {},
      at: row.created_at,
    });
    const expected: string = createHash('sha256').update((prev ?? '') + payload).digest('hex');
    if (expected !== row.row_hash || (row.prev_hash ?? null) !== prev) {
      return { ok: false, checked: i + 1, brokenAt: i };
    }
    prev = row.row_hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}

// --- SIEM export (docs/nexus/08 §Q; the real Microsoft Sentinel sink is a documented seam) ---

export interface ExportableRow extends AuditRow {
  id: string;
  actor_plane: string | null;
  resource_type: string | null;
}

/** Pluggable SIEM destination. The real Microsoft Sentinel sink implements this. */
export interface SiemSink {
  push(records: ExportableRow[]): Promise<{ accepted: number }>;
}

/** Mock sink: records nothing externally, just acknowledges (dev/test default). */
export class LogSiemSink implements SiemSink {
  async push(records: ExportableRow[]): Promise<{ accepted: number }> {
    return { accepted: records.length };
  }
}

function cefEscapeHeader(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
function cefEscapeExt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, ' ');
}

/** Format one audit row as an ArcSight CEF line. Pure. */
export function toCef(row: ExportableRow): string {
  const name = cefEscapeHeader(row.action);
  const header = `CEF:0|Nexus|Platform|1.0|${name}|${name}|3`;
  const ext = [
    `externalId=${cefEscapeExt(row.id)}`,
    `rt=${cefEscapeExt(row.created_at)}`,
    `suser=${cefEscapeExt(row.actor_id ?? '')}`,
    `act=${cefEscapeExt(row.action)}`,
    `cs1Label=resourceType cs1=${cefEscapeExt(row.resource_type ?? '')}`,
    `cs2Label=resourceId cs2=${cefEscapeExt(row.resource_id ?? '')}`,
    `cs3Label=plane cs3=${cefEscapeExt(row.actor_plane ?? '')}`,
  ].join(' ');
  return `${header}|${ext}`;
}

/** Serialize rows for export in the requested format. Pure. */
export function formatExport(rows: ExportableRow[], format: 'ndjson' | 'cef'): string {
  if (format === 'cef') return rows.map(toCef).join('\n');
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

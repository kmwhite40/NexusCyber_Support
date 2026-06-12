import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { audit, verifyChain, formatExport, type ExportableRow } from '../../src/modules/audit.js';

describeDb('audit chain + SIEM export (integration)', () => {
  it('writes self-consistent rows that verify as an intact chain', async () => {
    // Two audited actions on the live table.
    await audit(null, { action: 'test.audit.alpha', detail: { n: 1 } });
    await audit(null, { action: 'test.audit.beta', detail: { n: 2 } });

    const rows = await withSystemContext(async (sql) =>
      (
        await sql.query(
          `SELECT actor_id, action, resource_id, detail,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                  prev_hash, row_hash
             FROM audit_logs ORDER BY created_at ASC`,
        )
      ).rows,
    );

    const result = verifyChain(rows as Parameters<typeof verifyChain>[0]);
    expect(result.ok).toBe(true);
    expect(result.brokenAt).toBeNull();
    expect(result.checked).toBeGreaterThanOrEqual(2);
  });

  it('formats an export as NDJSON and CEF', async () => {
    const rows = await withSystemContext(async (sql) =>
      (
        await sql.query(
          `SELECT id, actor_id, actor_plane, action, resource_type, resource_id, detail,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                  prev_hash, row_hash
             FROM audit_logs ORDER BY created_at ASC LIMIT 5`,
        )
      ).rows as ExportableRow[],
    );
    const ndjson = formatExport(rows, 'ndjson');
    expect(ndjson.split('\n').length).toBe(rows.length);
    const cef = formatExport(rows, 'cef');
    expect(cef.startsWith('CEF:0|Nexus|Platform|1.0|')).toBe(true);
  });
});

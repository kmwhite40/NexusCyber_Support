import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// A retention hold outlives its ticket and its run — up to seven years. The schema has to make
// that survivable, which is what these tests pin.
describeDb('retention_holds schema', () => {
  it('carries the denormalized identity a hold needs to outlive its ticket', async () => {
    const cols = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'retention_holds' ORDER BY column_name`,
      )).rows.map((r: { column_name: string }) => r.column_name));
    for (const c of ['upn', 'entra_object_id', 'display_name_at_offboard',
      'retention_class', 'retain_until', 'state', 'last_checked_at',
      'classification_basis', 'organization_id', 'run_id', 'ticket_id']) {
      expect(cols).toContain(c);
    }
  });

  it('nulls its references instead of cascading — a tidied ticket must not erase an obligation', async () => {
    // If a hold cascaded from tickets, deleting a ticket would silently destroy the record of an
    // obligation with six years left to run, and the absence would look exactly like compliance.
    const rules = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT conname, confdeltype FROM pg_constraint
          WHERE conrelid = 'retention_holds'::regclass AND contype = 'f'
            AND confrelid IN ('tickets'::regclass, 'provisioning_runs'::regclass)`,
      )).rows.map((r: { confdeltype: string }) => r.confdeltype));
    expect(rules.length).toBe(2);
    // 'n' = SET NULL. 'c' would be CASCADE, which is the bug this test exists to prevent.
    expect(rules.every((r: string) => r === 'n')).toBe(true);
  });

  it('refuses a second live hold for one account', async () => {
    const idx = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'retention_holds' AND indexname = 'retention_holds_account_live_idx'`,
      )).rows[0]?.indexdef as string | undefined);
    expect(idx).toBeDefined();
    expect(idx).toContain('UNIQUE');
    expect(idx).toContain('entra_object_id');
  });

  it('has the retention review catalog item the sweeper raises tickets against', async () => {
    const row = await withSystemContext(async (sql) =>
      (await sql.query(
        "SELECT key, ticket_type FROM service_catalog_items WHERE key = 'security.retention_review'",
      )).rows[0]);
    expect(row?.key).toBe('security.retention_review');
    expect(row?.ticket_type).toBe('service_request');
  });
});

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

// Two defects in 0069 that could only be fixed forward: it is already applied in production.
describeDb('retention_holds follow-up fixes', () => {
  it('has the app-role grants it needs (via 0001 default privileges, verified not assumed)', async () => {
    // A review flagged this as a missing GRANT. It is not: 0001's ALTER DEFAULT PRIVILEGES IN
    // SCHEMA public covers tables created later, so retention_holds picked them up on creation.
    // Kept as a regression test because the claim was plausible enough to be worth pinning.
    const grants = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'retention_holds' AND grantee = 'nexus_app'`,
      )).rows.map((r: { privilege_type: string }) => r.privilege_type));
    for (const p of ['SELECT', 'INSERT', 'UPDATE']) expect(grants).toContain(p);
  });

  it('keys fulfillment steps on role, the way catalog steps are actually read', async () => {
    // seed's step() emits { key, label, role, automatable }. 0069 wrote "tier", and prod does
    // NOT run seed — so there the migration is the only source and every step lands with a null
    // assignee role. NOTE this test is weak LOCALLY, where seed runs after migrate and masks the
    // bug; migration 0070 is what actually repairs the databases where it is real.
    const keys = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT jsonb_object_keys(s) AS k
           FROM service_catalog_items sci, jsonb_array_elements(sci.fulfillment_steps) s
          WHERE sci.key = 'security.retention_review'`,
      )).rows.map((r: { k: string }) => r.k));
    expect(keys).toContain('role');
    expect(keys).not.toContain('tier');
  });
});

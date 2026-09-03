import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// Per-customer Entra credentials and CMDB provenance. The secret columns are the reason this
// table is unlike the others: Key Vault is blocked by enclave policy, so the ciphertext lives
// here and the key lives in app config. The DB must never hold anything decryptable on its own.
describeDb('org_integrations schema', () => {
  it('stores the secret as ciphertext with its IV and tag, never as text', async () => {
    const cols = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'org_integrations' ORDER BY column_name`,
      )).rows as Array<{ column_name: string; data_type: string }>);
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    for (const c of ['secret_ciphertext', 'secret_iv', 'secret_tag']) {
      expect(byName[c]).toBe('bytea');
    }
    // A plaintext secret column would defeat the entire envelope-encryption design.
    expect(Object.keys(byName)).not.toContain('client_secret');
    expect(Object.keys(byName)).toContain('key_version');
  });

  it('allows one integration per organization and provider', async () => {
    const def = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'org_integrations'::regclass AND contype = 'u'`,
      )).rows.map((r: { def: string }) => r.def).join(' '));
    expect(def).toContain('organization_id');
    expect(def).toContain('provider');
  });

  it('gives configuration_items provenance, defaulting to manual', async () => {
    // Existing CIs were created by hand and must stay untouched by any sync.
    const rows = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT column_name, column_default FROM information_schema.columns
          WHERE table_name = 'configuration_items' AND column_name IN ('source','external_id')`,
      )).rows as Array<{ column_name: string; column_default: string | null }>);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.column_name === 'source')?.column_default).toContain('manual');
  });

  it('keys synced CIs uniquely per org, source and external id', async () => {
    const idx = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_ci_source_external'`,
      )).rows[0]?.indexdef as string | undefined);
    expect(idx).toBeDefined();
    expect(idx).toContain('UNIQUE');
    // Partial: manual CIs have no external_id and must not collide with each other.
    expect(idx).toContain('external_id IS NOT NULL');
  });

  it('isolates both new tables by organization', async () => {
    const policies = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT tablename FROM pg_policies
          WHERE tablename IN ('org_integrations','integration_sync_runs')`,
      )).rows.map((r: { tablename: string }) => r.tablename).sort());
    expect(policies).toEqual(['integration_sync_runs', 'org_integrations']);
  });
});

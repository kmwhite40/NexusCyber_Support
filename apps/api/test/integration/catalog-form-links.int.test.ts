import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// The catalog->form links are DUAL-WRITTEN, and both halves are load-bearing:
//
//   seed.ts    covers a FRESH database, where migrate runs before the catalog rows exist and a
//              migration's UPDATE would match nothing.
//   migration  covers an EXISTING database (prod), where the rows are already there and seed is
//              too blunt an instrument to run — it wipes and rebuilds every role's permissions
//              and overwrites every catalog item's name, SLA and fulfilment steps.
//
// Same discipline as the seeded KB articles. This test pins the invariant both halves exist to
// keep, so neither can be edited alone without something failing.
const LEGACY_UNLINKED = new Set(['new_user_access', 'new_user_provisioning']);

describeDb('catalog items are linked to their forms (dual-written)', () => {
  it('leaves no global form with fields orphaned', async () => {
    const orphans = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT rf.key FROM request_forms rf
          WHERE rf.organization_id IS NULL
            AND EXISTS (SELECT 1 FROM form_fields ff WHERE ff.form_id = rf.id)
            AND NOT EXISTS (SELECT 1 FROM service_catalog_items sci WHERE sci.form_key = rf.key)
          ORDER BY rf.key`,
      )).rows.map((r: { key: string }) => r.key).filter((k: string) => !LEGACY_UNLINKED.has(k)));
    expect(orphans).toEqual([]);
  });

  it('links every catalog item that has a form, with no dangling form_key', async () => {
    // A form_key pointing at a form that does not exist is worse than NULL: createRequest would
    // resolve no fields and drop every answer, exactly as an unlinked item does, but nothing in
    // the data would look wrong.
    const dangling = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT sci.key, sci.form_key FROM service_catalog_items sci
          WHERE sci.form_key IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM request_forms rf WHERE rf.key = sci.form_key AND rf.organization_id IS NULL
            )`,
      )).rows);
    expect(dangling).toEqual([]);
  });
});

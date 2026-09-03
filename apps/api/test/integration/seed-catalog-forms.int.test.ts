import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// Forms are created by MIGRATIONS; the catalog items that use them are created by SEED; and
// migrate always runs before seed. So the migrations' `UPDATE service_catalog_items SET
// form_key=... WHERE key=...` matched zero rows on a fresh database and silently did nothing,
// leaving every seed-created catalog item with a NULL form_key.
//
// The consequence was invisible rather than loud: createRequest validates answers against the
// linked form's fields, so with no form it dropped EVERY submitted answer as unknown and stored
// `custom_fields = {}`. No error, no warning — the requester's input simply vanished. On a fresh
// install that was all 32 seed-created catalog items at once. Long-lived databases (dev, prod)
// were fine only by accident: they had been seeded before those migrations were written, so the
// rows existed when the UPDATEs ran.
//
// These two tests pin the contract from both ends: nothing builds a form and forgets to wire it
// up, and the onboarding intake specifically stays linked.

// Superseded by later migrations (0037 moved user.provisioning to 'user_onboarding'), or seeded
// as standalone forms with no catalog item. Legitimately referenced by nothing.
const LEGACY_UNLINKED = new Set(['new_user_access', 'new_user_provisioning']);

describeDb('seeded catalog items are linked to their request forms', () => {
  it('leaves no global form with fields orphaned', async () => {
    const rows = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT rf.key
           FROM request_forms rf
          WHERE rf.organization_id IS NULL
            AND EXISTS (SELECT 1 FROM form_fields ff WHERE ff.form_id = rf.id)
            AND NOT EXISTS (SELECT 1 FROM service_catalog_items sci WHERE sci.form_key = rf.key)
          ORDER BY rf.key`,
      )).rows,
    );
    const orphans = rows
      .map((r: { key: string }) => r.key)
      .filter((k: string) => !LEGACY_UNLINKED.has(k));
    expect(orphans).toEqual([]);
  });

  it('links the onboarding intake, whose answers the provisioning planner reads back', async () => {
    // planner.ts derives the UPN from legal_first_name / legal_last_name in custom_fields. With
    // no form linked those answers never land, and provisioning has nothing to plan from.
    const row = await withSystemContext(async (sql) =>
      (await sql.query(
        "SELECT form_key FROM service_catalog_items WHERE key = 'user.provisioning'",
      )).rows[0],
    );
    expect(row?.form_key).toBe('user_onboarding');
  });
});

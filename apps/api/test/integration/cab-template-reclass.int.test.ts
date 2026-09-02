// Migration 0062 — the pre-approvals that predate the CRITICAL-1 fix.
//
// 0052 created change_templates.change_type with DEFAULT 'standard' and the old
// createTemplate inherited it, so on any database migrated before 0061 every existing
// template is a standing pre-approval — including any authored by a ServiceDeskManager while
// that role still held change.create. 0061 bound `standard` changes to a template but did not
// touch existing rows, which left the closed hole open on the live data and then offered
// every one of those rows in the new raiser-facing template picker.
//
// Two tests, because neither alone is enough: the first proves the migration's SQL actually
// reclassifies (in a rolled-back transaction, since the migration itself runs once), and the
// second pins the invariant on whatever data this database really holds.
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

const MIGRATION = '0062_cab_template_reclassification.sql';
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations', MIGRATION,
);

describeDb('CAB pre-approval reclassification (migration 0062)', () => {
  it('reclassifies a legacy standard template and its draft, and leaves history alone', async () => {
    const ddl = await readFile(migrationPath, 'utf8');
    await withSystemContext(async (sql) => {
      const orgId = (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id;
      // The migration has already run on this database, so replay it against rows shaped
      // like the legacy ones inside a transaction that is rolled back.
      await sql.query('BEGIN');
      try {
        const tpl = (await sql.query(
          `INSERT INTO change_templates (organization_id, name, change_type)
           VALUES ($1, 'legacy default pre-approval', 'standard') RETURNING id`, [orgId],
        )).rows[0];
        const draft = (await sql.query(
          `INSERT INTO changes (organization_id, title, change_type, risk, status, created_by)
           VALUES ($1, 'legacy standard draft', 'standard', 'low', 'draft', NULL) RETURNING id`, [orgId],
        )).rows[0];
        const shipped = (await sql.query(
          `INSERT INTO changes (organization_id, title, change_type, risk, status, created_by)
           VALUES ($1, 'legacy standard, already approved', 'standard', 'low', 'approved', NULL) RETURNING id`, [orgId],
        )).rows[0];

        await sql.query(ddl);

        const typeOf = async (table: string, id: string) =>
          (await sql.query(`SELECT change_type FROM ${table} WHERE id=$1`, [id])).rows[0].change_type;
        // The standing pre-approval is withdrawn: re-declaring it is a deliberate cab.manage act.
        expect(await typeOf('change_templates', tpl.id)).toBe('normal');
        // The draft routes through the CAB rather than 403-ing at submit with no way forward.
        expect(await typeOf('changes', draft.id)).toBe('normal');
        // A decision already made under the old rules is history; rewriting it would falsify
        // the audit trail without changing its outcome.
        expect(await typeOf('changes', shipped.id)).toBe('standard');
      } finally {
        await sql.query('ROLLBACK');
      }
    });
  });

  it('leaves no pre-0062 template standing as a pre-approval on this database', async () => {
    const rows = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT t.id, t.name FROM change_templates t
          WHERE t.change_type = 'standard'
            AND t.created_at < (SELECT applied_at FROM schema_migrations WHERE filename = $1)`,
        [MIGRATION],
      )).rows);
    // Templates authored deliberately after the reclassification keep their type; anything
    // predating it was a default, not a decision.
    expect(rows).toEqual([]);
  });
});

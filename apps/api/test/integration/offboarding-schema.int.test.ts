import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// Offboarding shares the provisioning run tables rather than growing its own: run history,
// in-flight guards and per-step evidence are the same problem in both directions. `kind` is what
// keeps the two flows apart in every query that must not mix them, and `scheduled_for` is what
// lets an approved plan wait for HR's instant instead of firing on approval.
describeDb('offboarding run schema', () => {
  it('carries the kind discriminator and a scheduled_for instant', async () => {
    const cols = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'provisioning_runs' AND column_name IN ('kind','scheduled_for')
          ORDER BY column_name`,
      );
      return rows.map((r: { column_name: string }) => r.column_name);
    });
    expect(cols).toEqual(['kind', 'scheduled_for']);
  });

  it('allows the scheduled and needs_review run statuses', async () => {
    // 'scheduled' = approved and armed, waiting for scheduled_for.
    // 'needs_review' = fired, security steps done, data-affecting steps halted on plan drift.
    const defs = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'provisioning_runs'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%status%'`,
      );
      return rows.map((r: { def: string }) => r.def).join(' ');
    });
    expect(defs).toContain('scheduled');
    expect(defs).toContain('needs_review');
  });

  it('still defaults existing rows to onboarding, so the provisioning flow is untouched', async () => {
    const def = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name = 'provisioning_runs' AND column_name = 'kind'`,
      );
      return rows[0]?.column_default as string | undefined;
    });
    expect(def).toContain('onboarding');
  });
});

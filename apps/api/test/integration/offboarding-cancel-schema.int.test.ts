import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

describeDb('offboarding run cancellation', () => {
  it('allows a cancelled run status', async () => {
    // Distinct from 'failed': nothing went wrong, a human decided not to proceed.
    const def = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'provisioning_runs'::regclass
            AND conname = 'provisioning_runs_status_check'`,
      )).rows[0]?.def as string | undefined);
    expect(def).toContain('cancelled');
  });
});

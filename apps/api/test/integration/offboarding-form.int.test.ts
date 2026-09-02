import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// "Block them at 5pm Friday" cannot be expressed as YYYY-MM-DD, and the offboarding sweeper
// fires on an instant. The intake asked for a bare date.
//
// The zone lives IN the value (the datetime validator requires a Z or ±HH:MM designator) rather
// than in a separate timezone field. Two fields would be two sources of truth for one fact, with
// nothing to say which wins when they disagree.
describeDb('offboarding intake captures an instant', () => {
  it('asks for a disable date AND time', async () => {
    const field = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT ff.data_type FROM form_fields ff
           JOIN request_forms rf ON rf.id = ff.form_id
          WHERE rf.key = 'm365_offboard' AND ff.key = 'disable_effective'`,
      );
      return rows[0]?.data_type as string | undefined;
    });
    expect(field).toBe('datetime');
  });

  it('does not carry a redundant separate timezone field', async () => {
    const count = await withSystemContext(async (sql) => {
      const { rows } = await sql.query(
        `SELECT count(*)::int AS n FROM form_fields ff
           JOIN request_forms rf ON rf.id = ff.form_id
          WHERE rf.key = 'm365_offboard' AND ff.key = 'disable_timezone'`,
      );
      return rows[0].n as number;
    });
    expect(count).toBe(0);
  });
});

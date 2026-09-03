import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createSchedule, listSchedules, removeParticipant, deleteSchedule, setResponderPhone } from '../../src/modules/oncall.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('on-call management: delete schedule, remove responder, set cell (integration)', () => {
  let manager: Principal; // ServiceDeskManager -> oncall.manage
  let ids: string[];

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    ids = (await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM users WHERE plane='nexus' AND status='active' ORDER BY display_name LIMIT 4")).rows,
    )).map((r) => r.id);
  });

  it('create → set cell → remove a responder (re-packs order) → delete', async () => {
    const team = `Test Ops Rotation ${Date.now()}`;
    const { id } = await createSchedule(manager, { team, participantIds: [ids[0], ids[1], ids[2]] });

    // Set a cell number on the first responder; it surfaces in the schedule roster.
    await setResponderPhone(manager, ids[0], '+1 (555) 010-0001');
    let sched = (await listSchedules(manager)).find((s: any) => s.id === id)!;
    expect(sched.participants.find((p: any) => p.user_id === ids[0])?.phone).toBe('+1 (555) 010-0001');
    expect(sched.participants).toHaveLength(3);

    // Remove the middle responder → 2 remain at contiguous positions 0,1.
    const res = await removeParticipant(manager, id, ids[1]);
    expect(res.remaining).toBe(2);
    sched = (await listSchedules(manager)).find((s: any) => s.id === id)!;
    expect(sched.participants.map((p: any) => p.user_id)).toEqual([ids[0], ids[2]]);
    expect(sched.participants.map((p: any) => p.position)).toEqual([0, 1]);

    // Delete the schedule.
    await deleteSchedule(manager, id);
    expect((await listSchedules(manager)).find((s: any) => s.id === id)).toBeFalsy();
  });

  it('refuses to remove the last responder (delete the schedule instead)', async () => {
    const team = `Test Solo Rotation ${Date.now()}`;
    const { id } = await createSchedule(manager, { team, participantIds: [ids[0]] });
    await expect(removeParticipant(manager, id, ids[0])).rejects.toThrow(/last responder/i);
    await deleteSchedule(manager, id); // cleanup
  });

  it('clears a cell number when set to null', async () => {
    await setResponderPhone(manager, ids[3], '+1 (555) 999-9999');
    const cleared = await setResponderPhone(manager, ids[3], null);
    expect(cleared.phone).toBeNull();
  });
});

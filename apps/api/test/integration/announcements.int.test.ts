import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createAnnouncement, listActive, deactivate } from '../../src/modules/announcements.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('portal announcements (integration)', () => {
  let manager: Principal; // automation.author -> can manage
  let endUser: Principal; // sees active announcements

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    endUser = await principalByEmail('user@acme.example.com');
  });

  it('a created global announcement is visible to customers, then retractable', async () => {
    const marker = `Maintenance ${Date.now()}`;
    const a = await createAnnouncement(manager, { title: marker, body: 'Planned window Saturday 02:00 UTC', severity: 'warning' });

    const visible = await listActive(endUser);
    expect(visible.find((x: any) => x.id === a.id)).toBeTruthy();

    await deactivate(manager, a.id);
    const after = await listActive(endUser);
    expect(after.find((x: any) => x.id === a.id)).toBeFalsy();
  });

  it('end users cannot create announcements', async () => {
    await expect(createAnnouncement(endUser, { title: 'nope', body: 'x' })).rejects.toThrow(/not permitted/i);
  });
});

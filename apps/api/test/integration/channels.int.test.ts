import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { listChannels, createChannel, updateChannel } from '../../src/modules/channels.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('channels (integration)', () => {
  let manager: Principal;
  let enduser: Principal;
  let orgId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    // EndUser (customer plane) lacks channel.read — Tier2 has it, so use a customer user
    enduser = await principalByEmail('user@demo.example.com');
    orgId = await withSystemContext(async (sql) => (await sql.query('SELECT id FROM organizations LIMIT 1')).rows[0].id);
  });

  it('manager creates, lists, and toggles a channel', async () => {
    const ch = await createChannel(manager, { type: 'email', name: 'int-support', organizationId: orgId });
    expect(ch.enabled).toBe(true);
    const list = await listChannels(manager);
    expect(list.some((c: any) => c.id === ch.id)).toBe(true);
    const updated = await updateChannel(manager, ch.id, { enabled: false });
    expect(updated.enabled).toBe(false);
  });

  it('a customer end-user without channel.read is denied list', async () => {
    await expect(listChannels(enduser)).rejects.toThrow();
  });
});

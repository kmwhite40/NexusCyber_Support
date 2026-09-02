// Security regressions for the CAB admin surface (fix round 1).
// Global (organization_id IS NULL) boards/blackouts/templates are inherited by every
// organization, and migration 0052's RLS policy deliberately makes them visible from every
// org context — so RLS alone cannot protect them from writes or deletes. These assert the
// app-layer gate: `cab.manage` covers your own org, `cab.manage.global` covers the globals.
import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import {
  createBlackout, deleteBlackout, listBlackouts,
  createTemplate, deleteTemplate, listTemplates, putBoard,
} from '../../src/modules/cab.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('CAB admin scope (integration)', () => {
  let manager: Principal;  // cab.manage, scoped to ONE org, no cab.manage.global
  let agent: Principal;    // no cab.manage at all
  let platform: Principal; // SuperAdmin, all orgs
  let acmeId: string;

  beforeAll(async () => {
    manager = await principalByEmail('manager@nexus.example.com');
    agent = await principalByEmail('agent@nexus.example.com');
    platform = await principalByEmail('admin1@anchor.local');
    acmeId = await withSystemContext(async (sql) => (await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'")).rows[0].id);
    expect(manager.permissions).toContain('cab.manage');
    expect(manager.permissions).not.toContain('cab.manage.global');
    expect(manager.allOrgs).toBe(false);
  });

  // ---- CRITICAL 1: unscoped delete of a global row ----

  it('refuses a single-org cab.manage holder deleting a GLOBAL blackout', async () => {
    const global = await createBlackout(platform, {
      organizationId: null, name: 'Year-end freeze', startsAt: '2026-12-24T00:00:00.000Z', endsAt: '2026-12-27T00:00:00.000Z',
    });
    expect(global.organization_id).toBeNull();
    try {
      await expect(deleteBlackout(manager, global.id)).rejects.toMatchObject({ status: 403 });
      // …and it is still there.
      const still = await withSystemContext(async (sql) =>
        (await sql.query('SELECT id FROM change_blackouts WHERE id=$1', [global.id])).rows[0]);
      expect(still).toBeTruthy();
    } finally {
      await deleteBlackout(platform, global.id);
    }
  });

  it('refuses a single-org cab.manage holder deleting a GLOBAL template', async () => {
    const global = await createTemplate(platform, { organizationId: null, name: 'Global standard change' });
    expect(global.organization_id).toBeNull();
    try {
      await expect(deleteTemplate(manager, global.id)).rejects.toMatchObject({ status: 403 });
      const still = await withSystemContext(async (sql) =>
        (await sql.query('SELECT id FROM change_templates WHERE id=$1', [global.id])).rows[0]);
      expect(still).toBeTruthy();
    } finally {
      await deleteTemplate(platform, global.id);
    }
  });

  it('still lets the platform-wide grant delete a global row', async () => {
    const global = await createBlackout(platform, {
      organizationId: null, name: 'Temporary global freeze', startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-01-02T00:00:00.000Z',
    });
    expect(await deleteBlackout(platform, global.id)).toEqual({ deleted: true });
  });

  // ---- CRITICAL 2: writing the global scope ----

  it('refuses a single-org cab.manage holder rewriting the GLOBAL default board', async () => {
    await expect(putBoard(manager, { organizationId: null, quorum: 1, members: [] })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses the implicit-global vector: a nexus caller naming no organizationId', async () => {
    // pdp.ts short-circuits inOrgScope when organizationId is undefined, so before the fix
    // this silently targeted the GLOBAL default.
    await expect(putBoard(manager, { quorum: 9 })).rejects.toMatchObject({ status: 403 });
    await expect(
      createBlackout(manager, { name: 'implicitly global', startsAt: '2027-02-01T00:00:00.000Z', endsAt: '2027-02-02T00:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(createTemplate(manager, { name: 'implicitly global' })).rejects.toMatchObject({ status: 403 });
  });

  it('lets the same holder configure their OWN org', async () => {
    const own = await createBlackout(manager, {
      organizationId: acmeId, name: 'Org freeze', startsAt: '2027-03-01T00:00:00.000Z', endsAt: '2027-03-02T00:00:00.000Z',
    });
    expect(own.organization_id).toBe(acmeId);

    // IMPORTANT 7: the delete audit must name the ROW's org, not the (null) actor org.
    await deleteBlackout(manager, own.id);
    const entry = await withSystemContext(async (sql) =>
      (await sql.query("SELECT organization_id FROM audit_logs WHERE action='cab.blackout.delete' AND resource_id=$1", [own.id])).rows[0]);
    expect(entry.organization_id).toBe(acmeId);
  });

  // ---- IMPORTANT 3: reads were ungated ----

  it('refuses blackout and template reads without cab.manage', async () => {
    expect(agent.permissions).not.toContain('cab.manage');
    await expect(listBlackouts(agent, acmeId)).rejects.toMatchObject({ status: 403 });
    await expect(listTemplates(agent, acmeId)).rejects.toMatchObject({ status: 403 });
    // The holder still reads their own org's rows plus the inherited globals.
    await expect(listBlackouts(manager, acmeId)).resolves.toBeInstanceOf(Array);
  });
});

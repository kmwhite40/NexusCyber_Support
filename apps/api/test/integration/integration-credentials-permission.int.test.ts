import { it, expect } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';

// Configuring a customer's Entra credentials is a PLATFORM action, not a customer one: the
// secret Nexus stores is used to read that customer's directory.
//
// Deliberately NOT named 'integrations.manage' as the June plan proposed — 'integration.manage'
// already exists (M2M API keys, outbound webhooks) and is held by ServiceDeskManager AND the
// customer-plane OrgAdmin. Two permissions one letter apart is how you get a 403 nobody can
// explain, and reusing the existing one would have widened a customer role to directory
// credentials.
describeDb('integration credential permission', () => {
  it('exists as a distinct permission', async () => {
    const k = await withSystemContext(async (sql) =>
      (await sql.query(
        "SELECT key FROM permissions WHERE key = 'integration.credentials.manage'",
      )).rows[0]?.key);
    expect(k).toBe('integration.credentials.manage');
  });

  it('is granted to platform admins only, never to a customer-plane role', async () => {
    const roles = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT r.key, r.plane FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          WHERE rp.permission_key = 'integration.credentials.manage' ORDER BY r.key`,
      )).rows as Array<{ key: string; plane: string }>);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.every((r) => r.plane === 'nexus')).toBe(true);
    expect(roles.map((r) => r.key)).toContain('ServiceDeskManager');
  });

  it('leaves the existing integration.manage grants alone', async () => {
    // OrgAdmin keeps API keys and webhooks. This change must not widen or narrow that.
    const roles = await withSystemContext(async (sql) =>
      (await sql.query(
        `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          WHERE rp.permission_key = 'integration.manage' ORDER BY r.key`,
      )).rows.map((r: { key: string }) => r.key));
    expect(roles).toContain('OrgAdmin');
    expect(roles).toContain('ServiceDeskManager');
  });
});

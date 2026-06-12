import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { requestElevation, approveElevation, breakGlass } from '../../src/modules/elevation.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const user = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: user.id, plane: user.plane, email: user.email, org: user.organization_id, roles: [] });
}

describeDb('JIT elevation (integration)', () => {
  let analyst: Principal; // elevation.request + break_glass
  let manager: Principal; // elevation.approve

  beforeAll(async () => {
    analyst = await principalByEmail('analyst@nexus.example.com');
    manager = await principalByEmail('manager@nexus.example.com');
  });

  it('request -> approve activates a grant whose perms appear on the elevated principal', async () => {
    const g = await requestElevation(analyst, { permissions: ['ticket.assign'], reason: 'covering escalation' });
    expect(g.status).toBe('requested');
    const res = await approveElevation(manager, g.id, 30);
    expect(res.status).toBe('active');

    // Reload the analyst — the granted permission is now effective and elevated is true.
    const reloaded = await principalByEmail('analyst@nexus.example.com');
    expect(reloaded.permissions).toContain('ticket.assign');
    expect(reloaded.elevated).toBe(true);
  });

  it('enforces separation of duties on approval', async () => {
    // The manager holds BOTH request and approve, so self-approval reaches (and trips) the
    // SoD check rather than failing earlier at the permission gate.
    const g = await requestElevation(manager, { permissions: ['audit.read'], reason: 'self-approve attempt' });
    await expect(approveElevation(manager, g.id, 30)).rejects.toThrow(/separation of duties/i);
  });

  it('break-glass activates immediately and is recorded as break_glass', async () => {
    const g = await breakGlass(analyst, { permissions: ['ticket.assign'], reason: 'production incident' });
    expect(g.status).toBe('active');
    expect(g.break_glass).toBe(true);
  });
});

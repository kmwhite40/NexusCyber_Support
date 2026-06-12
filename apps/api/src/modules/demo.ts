// Demo account view-toggle. A demo identity (is_demo) is linked to a paired identity in the
// other plane (demo_pair_user_id). An authenticated demo user can swap its session to the
// pair, flipping between the admin (nexus control-plane) and customer (portal) views.
import { withSystemContext } from '../db/pool.js';
import { issueSession } from '../auth/session.js';
import { loadPrincipal } from '../auth/principal.js';
import { Errors } from '../errors.js';
import type { Principal, SessionClaims } from '../types.js';

function viewLabel(plane: string): 'admin' | 'customer' {
  return plane === 'nexus' ? 'admin' : 'customer';
}

interface DemoUserRow {
  id: string;
  plane: 'nexus' | 'customer';
  email: string;
  organization_id: string | null;
  is_demo: boolean;
  demo_pair_user_id: string | null;
}

async function loadDemoUser(userId: string): Promise<DemoUserRow | undefined> {
  return withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id, is_demo, demo_pair_user_id FROM users WHERE id=$1', [userId])).rows[0],
  );
}

/** Whether the current principal is a demo account, and what the toggle target is. */
export async function status(actor: Principal) {
  const me = await loadDemoUser(actor.id);
  if (!me || !me.is_demo || !me.demo_pair_user_id) {
    return { isDemo: false, currentView: null as null | 'admin' | 'customer', otherView: null as null | 'admin' | 'customer' };
  }
  const pair = await loadDemoUser(me.demo_pair_user_id);
  return {
    isDemo: true,
    currentView: viewLabel(me.plane),
    otherView: pair ? viewLabel(pair.plane) : null,
  };
}

/** Issue a session for the demo user's paired identity (the "other view"). */
export async function toggle(actor: Principal): Promise<{ token: string; principal: Principal; view: 'admin' | 'customer' }> {
  const me = await loadDemoUser(actor.id);
  if (!me || !me.is_demo) throw Errors.forbidden('not a demo account');
  if (!me.demo_pair_user_id) throw Errors.conflict('demo account has no paired view');

  const pair = await withSystemContext(async (sql) =>
    (
      await sql.query(
        `SELECT u.id, u.plane, u.email, u.organization_id,
                COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
           FROM users u
           LEFT JOIN role_assignments ra ON ra.user_id = u.id
           LEFT JOIN roles r ON r.id = ra.role_id
          WHERE u.id = $1
          GROUP BY u.id`,
        [me.demo_pair_user_id],
      )
    ).rows[0],
  );
  if (!pair) throw Errors.notFound('paired demo identity not found');

  const claims: Omit<SessionClaims, 'iat' | 'exp'> = {
    sub: pair.id,
    plane: pair.plane,
    email: pair.email,
    org: pair.organization_id,
    roles: pair.roles,
  };
  const token = issueSession(claims);
  const principal = await loadPrincipal(claims as SessionClaims);
  return { token, principal, view: viewLabel(pair.plane) };
}

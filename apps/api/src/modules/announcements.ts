// Portal announcements (JSM parity). Active, in-window banners shown to customers.
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { can } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export interface AnnouncementWindow {
  active: boolean;
  starts_at: string | Date;
  ends_at: string | Date | null;
}

/** Is an announcement currently visible (active and within its time window)? Pure. */
export function isActive(a: AnnouncementWindow, now = new Date()): boolean {
  if (!a.active) return false;
  if (new Date(a.starts_at).getTime() > now.getTime()) return false;
  if (a.ends_at && new Date(a.ends_at).getTime() < now.getTime()) return false;
  return true;
}

function canManage(actor: Principal): boolean {
  return can(actor, 'automation.author') || can(actor, 'customer.admin.manage_users');
}

/** Active announcements visible to the principal (their org + global). */
export async function listActive(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, organization_id, title, body, severity, starts_at, ends_at
         FROM announcements
        WHERE active AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, starts_at DESC`,
    );
    return rows;
  });
}

/** All announcements (for management views). */
export async function listAll(actor: Principal) {
  if (!canManage(actor)) throw Errors.forbidden('not permitted to manage announcements');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query('SELECT * FROM announcements ORDER BY created_at DESC');
    return rows;
  });
}

export async function createAnnouncement(
  actor: Principal,
  input: { title: string; body: string; severity?: 'info' | 'warning' | 'critical'; endsAt?: string; organizationId?: string | null },
) {
  if (!canManage(actor)) throw Errors.forbidden('not permitted to manage announcements');
  const orgId = actor.plane === 'customer' ? actor.organizationId : input.organizationId ?? null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO announcements (organization_id, title, body, severity, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, input.title, input.body, input.severity ?? 'info', input.endsAt ?? null, actor.id],
    );
    await audit(actor, { action: 'announcement.create', organizationId: orgId, resourceType: 'announcement', resourceId: rows[0].id, detail: { severity: input.severity ?? 'info' } });
    return rows[0];
  });
}

/** Deactivate (retract) an announcement. Runs in the system context (authz via canManage)
 *  so global (NULL-org) announcements — which the tenant WITH CHECK would reject — can be
 *  retracted by an authorized agent. */
export async function deactivate(actor: Principal, id: string) {
  if (!canManage(actor)) throw Errors.forbidden('not permitted to manage announcements');
  return withSystemContext(async (sql) => {
    const a = (await sql.query('SELECT organization_id FROM announcements WHERE id=$1', [id])).rows[0];
    if (!a) throw Errors.notFound('announcement not found');
    // Nexus agents may only manage announcements for orgs in their scope (or global);
    // customers only their own org.
    if (a.organization_id) {
      if (actor.plane === 'customer' && a.organization_id !== actor.organizationId) throw Errors.forbidden('out of organization scope');
      if (actor.plane === 'nexus' && !actor.assignedOrgs.includes(a.organization_id)) throw Errors.forbidden('out of organization scope');
    }
    await sql.query('UPDATE announcements SET active=false WHERE id=$1', [id]);
    await audit(actor, { action: 'announcement.deactivate', organizationId: a.organization_id, resourceType: 'announcement', resourceId: id });
    return { ok: true };
  });
}

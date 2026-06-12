// Named dashboards over a fixed widget library. Widget DATA reuses existing analytics/posture
// queries elsewhere; this module owns dashboard records + the widget catalog.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export const WIDGET_CATALOG = ['kpis', 'ticket_volume', 'posture_gauge', 'top_findings', 'sla_breaches', 'recent_tickets'] as const;
export type WidgetType = (typeof WIDGET_CATALOG)[number];
export interface Widget { type: WidgetType }

/** Keep only known widget types, preserving order. Pure. */
export function sanitizeLayout(layout: unknown): Widget[] {
  if (!Array.isArray(layout)) return [];
  return layout
    .filter((w): w is { type: string } => !!w && typeof (w as { type?: unknown }).type === 'string')
    .filter((w) => (WIDGET_CATALOG as readonly string[]).includes(w.type))
    .map((w) => ({ type: w.type as WidgetType }));
}

const DASH_COLS = 'id, organization_id, owner_user_id, name, layout, is_default, created_at';

export async function listDashboards(actor: Principal) {
  authorize(actor, 'dashboard.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(`SELECT ${DASH_COLS} FROM dashboards ORDER BY is_default DESC, name`);
    return rows;
  });
}

export interface SaveDashboardInput { name?: string; layout?: unknown; organizationId?: string; }

export async function createDashboard(actor: Principal, input: SaveDashboardInput) {
  if (!input.name) throw Errors.badRequest('name required');
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'dashboard.manage', { organizationId: orgId });
  const layout = sanitizeLayout(input.layout);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO dashboards (organization_id, owner_user_id, name, layout, is_default) VALUES ($1,$2,$3,$4,false) RETURNING ${DASH_COLS}`,
      [orgId, actor.id, input.name, JSON.stringify(layout)],
    );
    await audit(actor, { action: 'dashboard.create', organizationId: orgId, resourceType: 'dashboard', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function updateDashboard(actor: Principal, id: string, input: SaveDashboardInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query(`SELECT id, organization_id, name, layout FROM dashboards WHERE id=$1`, [id])).rows[0];
    if (!cur) throw Errors.notFound('dashboard not found');
    authorize(actor, 'dashboard.manage', { organizationId: cur.organization_id });
    const layout = input.layout !== undefined ? sanitizeLayout(input.layout) : cur.layout;
    const { rows } = await sql.query(
      `UPDATE dashboards SET name=$1, layout=$2, updated_at=now() WHERE id=$3 RETURNING ${DASH_COLS}`,
      [input.name ?? cur.name, JSON.stringify(layout), id],
    );
    await audit(actor, { action: 'dashboard.update', organizationId: cur.organization_id, resourceType: 'dashboard', resourceId: id });
    return rows[0];
  });
}

export async function deleteDashboard(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT id, organization_id, is_default FROM dashboards WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('dashboard not found');
    authorize(actor, 'dashboard.manage', { organizationId: cur.organization_id });
    if (cur.is_default) throw Errors.conflict('cannot delete the default dashboard');
    await sql.query('DELETE FROM dashboards WHERE id=$1', [id]);
    await audit(actor, { action: 'dashboard.delete', organizationId: cur.organization_id, resourceType: 'dashboard', resourceId: id });
    return { ok: true };
  });
}

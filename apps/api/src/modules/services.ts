// Services & CMDB registry. Surfaces the services + configuration_items tables (0001),
// which tickets reference via service_id / ci_id. CRUD with org isolation via RLS.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export async function listServices(actor: Principal) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT s.*, (SELECT count(*)::int FROM tickets t WHERE t.service_id = s.id) AS ticket_count
         FROM services s ORDER BY s.name`,
    );
    return rows;
  });
}

export interface SaveServiceInput { name: string; kind?: string; organizationId?: string; }

export async function createService(actor: Principal, input: SaveServiceInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'service.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO services (organization_id, name, kind) VALUES ($1,$2,$3) RETURNING *`,
      [orgId, input.name, input.kind ?? 'application'],
    );
    await audit(actor, { action: 'service.create', organizationId: orgId, resourceType: 'service', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function listConfigurationItems(actor: Principal, filter: { ciClass?: string; status?: string } = {}) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.ciClass) { params.push(filter.ciClass); where.push(`ci_class = $${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    const { rows } = await sql.query(
      `SELECT ci.*, (SELECT count(*)::int FROM tickets t WHERE t.ci_id = ci.id) AS ticket_count
         FROM configuration_items ci ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ci.criticality DESC NULLS LAST, ci.name`,
      params,
    );
    return rows;
  });
}

// criticality is stored as smallint in DB; accept a numeric value (1–4) or map from text.
export interface SaveCiInput { name: string; ciClass: string; criticality?: string | number; status?: string; organizationId?: string; }

function parseCriticality(val: string | number | undefined): number {
  if (val === undefined) return 2; // default medium
  if (typeof val === 'number') return val;
  const map: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  return map[val.toLowerCase()] ?? 2;
}

export async function createConfigurationItem(actor: Principal, input: SaveCiInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'service.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO configuration_items (organization_id, ci_class, name, criticality, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.ciClass, input.name, parseCriticality(input.criticality), input.status ?? 'active'],
    );
    await audit(actor, { action: 'cmdb.ci.create', organizationId: orgId, resourceType: 'configuration_item', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

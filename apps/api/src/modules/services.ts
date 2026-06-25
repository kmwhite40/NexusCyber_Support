// Services & CMDB registry. Surfaces the services + configuration_items tables (0001),
// which tickets reference via service_id / ci_id. CRUD with org isolation via RLS.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export async function listServices(actor: Principal) {
  authorize(actor, 'service.read', {});
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
      [orgId, input.name, input.kind ?? 'technical'],
    );
    await audit(actor, { action: 'service.create', organizationId: orgId, resourceType: 'service', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

export async function listConfigurationItems(actor: Principal, filter: { ciClass?: string; status?: string } = {}) {
  authorize(actor, 'service.read', {});
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
export interface SaveCiInput {
  name: string;
  ciClass: string;
  criticality?: string | number;
  status?: string;
  owner?: string;
  supportGroup?: string;
  attributes?: Record<string, unknown>;
  organizationId?: string;
}

export const CI_REL_TYPES = ['depends_on', 'runs_on', 'hosts', 'connects_to', 'member_of', 'uses'] as const;
export type CiRelType = (typeof CI_REL_TYPES)[number];

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
      `INSERT INTO configuration_items (organization_id, ci_class, name, criticality, status, owner, support_group, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, input.ciClass, input.name, parseCriticality(input.criticality), input.status ?? 'active',
       input.owner ?? null, input.supportGroup ?? null, JSON.stringify(input.attributes ?? {})],
    );
    await audit(actor, { action: 'cmdb.ci.create', organizationId: orgId, resourceType: 'configuration_item', resourceId: rows[0].id, detail: { name: input.name } });
    return rows[0];
  });
}

/** A single CI with its attributes, both-direction relationships, and ticket count. */
export async function getConfigurationItem(actor: Principal, id: string) {
  authorize(actor, 'service.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const ci = (await sql.query('SELECT * FROM configuration_items WHERE id=$1', [id])).rows[0];
    if (!ci) throw Errors.notFound('configuration item not found');
    const ticketCount = (await sql.query('SELECT count(*)::int AS n FROM tickets WHERE ci_id=$1', [id])).rows[0].n;
    // Outgoing: this CI -> rel -> target. Incoming: source -> rel -> this CI.
    const outgoing = (await sql.query(
      `SELECT r.id, r.rel_type, r.target_ci_id AS ci_id, c.name, c.ci_class
         FROM ci_relationships r JOIN configuration_items c ON c.id = r.target_ci_id
        WHERE r.source_ci_id = $1 ORDER BY r.rel_type, c.name`, [id])).rows;
    const incoming = (await sql.query(
      `SELECT r.id, r.rel_type, r.source_ci_id AS ci_id, c.name, c.ci_class
         FROM ci_relationships r JOIN configuration_items c ON c.id = r.source_ci_id
        WHERE r.target_ci_id = $1 ORDER BY r.rel_type, c.name`, [id])).rows;
    return { ...ci, ticket_count: ticketCount, relationships: { outgoing, incoming } };
  });
}

export interface UpdateCiInput {
  criticality?: string | number;
  status?: string;
  owner?: string | null;
  supportGroup?: string | null;
  attributes?: Record<string, unknown>;
}

export async function updateConfigurationItem(actor: Principal, id: string, input: UpdateCiInput) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query('SELECT * FROM configuration_items WHERE id=$1', [id])).rows[0];
    if (!cur) throw Errors.notFound('configuration item not found');
    authorize(actor, 'service.manage', { organizationId: cur.organization_id });
    const { rows } = await sql.query(
      `UPDATE configuration_items
          SET criticality=$1, status=$2, owner=$3, support_group=$4, attributes=$5, updated_at=now()
        WHERE id=$6 RETURNING *`,
      [
        input.criticality !== undefined ? parseCriticality(input.criticality) : cur.criticality,
        input.status ?? cur.status,
        input.owner !== undefined ? input.owner : cur.owner,
        input.supportGroup !== undefined ? input.supportGroup : cur.support_group,
        JSON.stringify(input.attributes ?? cur.attributes ?? {}),
        id,
      ],
    );
    await audit(actor, { action: 'cmdb.ci.update', organizationId: cur.organization_id, resourceType: 'configuration_item', resourceId: id });
    return rows[0];
  });
}

export async function addCiRelationship(actor: Principal, input: { sourceId: string; targetId: string; relType: CiRelType }) {
  if (input.sourceId === input.targetId) throw Errors.badRequest('a CI cannot relate to itself');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    // Both CIs must be visible (RLS) and in the same org.
    const cis = (await sql.query('SELECT id, organization_id FROM configuration_items WHERE id = ANY($1)', [[input.sourceId, input.targetId]])).rows;
    if (cis.length !== 2) throw Errors.notFound('configuration item not found');
    if (cis[0].organization_id !== cis[1].organization_id) throw Errors.badRequest('CIs must be in the same organization');
    const orgId = cis[0].organization_id;
    authorize(actor, 'service.manage', { organizationId: orgId });
    const { rows } = await sql.query(
      `INSERT INTO ci_relationships (organization_id, source_ci_id, target_ci_id, rel_type)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (source_ci_id, target_ci_id, rel_type) DO NOTHING
       RETURNING *`,
      [orgId, input.sourceId, input.targetId, input.relType],
    );
    await audit(actor, { action: 'cmdb.relationship.create', organizationId: orgId, resourceType: 'ci_relationship', resourceId: rows[0]?.id ?? null, detail: { ...input } });
    return rows[0] ?? { duplicate: true };
  });
}

export async function removeCiRelationship(actor: Principal, id: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const rel = (await sql.query('SELECT * FROM ci_relationships WHERE id=$1', [id])).rows[0];
    if (!rel) throw Errors.notFound('relationship not found');
    authorize(actor, 'service.manage', { organizationId: rel.organization_id });
    await sql.query('DELETE FROM ci_relationships WHERE id=$1', [id]);
    await audit(actor, { action: 'cmdb.relationship.delete', organizationId: rel.organization_id, resourceType: 'ci_relationship', resourceId: id });
    return { deleted: true };
  });
}

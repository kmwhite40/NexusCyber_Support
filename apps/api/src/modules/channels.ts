// Configurable intake channels (email/portal/widget) per org.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

const CHANNEL_COLS = 'id, organization_id, type, name, config, enabled, created_at';

export async function listChannels(actor: Principal) {
  authorize(actor, 'channel.read', {});
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(`SELECT ${CHANNEL_COLS} FROM channels ORDER BY type, name`);
    return rows;
  });
}

export interface SaveChannelInput { type: 'email' | 'portal' | 'widget'; name: string; config?: Record<string, unknown>; enabled?: boolean; organizationId?: string; }

export async function createChannel(actor: Principal, input: SaveChannelInput) {
  const orgId = actor.plane === 'customer' ? actor.organizationId! : input.organizationId;
  if (!orgId) throw Errors.badRequest('organizationId required');
  authorize(actor, 'channel.manage', { organizationId: orgId });
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO channels (organization_id, type, name, config, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING ${CHANNEL_COLS}`,
      [orgId, input.type, input.name, JSON.stringify(input.config ?? {}), input.enabled ?? true],
    );
    await audit(actor, { action: 'channel.create', organizationId: orgId, resourceType: 'channel', resourceId: rows[0].id, detail: { type: input.type } });
    return rows[0];
  });
}

export async function updateChannel(actor: Principal, id: string, input: Partial<SaveChannelInput>) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const cur = (await sql.query(`SELECT id, organization_id, name, config, enabled FROM channels WHERE id=$1`, [id])).rows[0];
    if (!cur) throw Errors.notFound('channel not found');
    authorize(actor, 'channel.manage', { organizationId: cur.organization_id });
    const { rows } = await sql.query(
      `UPDATE channels SET name=$1, config=$2, enabled=$3, updated_at=now() WHERE id=$4 RETURNING ${CHANNEL_COLS}`,
      [input.name ?? cur.name, JSON.stringify(input.config ?? cur.config), input.enabled ?? cur.enabled, id],
    );
    await audit(actor, { action: 'channel.update', organizationId: cur.organization_id, resourceType: 'channel', resourceId: id });
    return rows[0];
  });
}

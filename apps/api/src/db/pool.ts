import pg from 'pg';
import { config } from '../config.js';

// Runtime pool connects as the non-owner app role so RLS is enforced on every query.
export const pool = new pg.Pool({
  connectionString: config.appDatabaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

// Admin pool (owner role) for migrations/seed/system jobs.
const adminPool = new pg.Pool({
  connectionString: config.adminDatabaseUrl,
  max: 4,
  idleTimeoutMillis: 30_000,
});

export type Sql = pg.PoolClient;

/**
 * Run a function inside a transaction with the tenant RLS context applied.
 *
 * This is the heart of tenant isolation (docs/nexus/02 §D.3 / 09 §S.1):
 * we set the per-request GUCs that the RLS policies read, inside a transaction
 * using set_config(..., is_local => true) so they never leak across pooled
 * connections. The application org-guard (authz layer) is the second layer.
 */
export interface OrgContext {
  plane: 'nexus' | 'customer';
  orgId: string | null;        // customer plane: the user's org
  assignedOrgs: string[];      // nexus plane: orgs the agent is scoped to
  allOrgs?: boolean;           // nexus plane: granted ALL orgs (org-NULL role assignment)
  elevated: boolean;
  superuser?: boolean;         // platform admin (admin.superuser): cross-org at the DB layer
}

export async function withOrgContext<T>(
  ctx: OrgContext,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.plane', $1, true)`, [ctx.plane]);
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [ctx.orgId ?? '']);
    await client.query(`SELECT set_config('app.assigned_orgs', $1, true)`, [
      ctx.assignedOrgs.join(','),
    ]);
    await client.query(`SELECT set_config('app.elevated', $1, true)`, [
      ctx.elevated ? 'true' : 'false',
    ]);
    // All-orgs grant (nexus role assigned org-NULL): RLS grants cross-org access without
    // requiring full platform-superuser. The principal's role still bounds their permissions.
    await client.query(`SELECT set_config('app.all_orgs', $1, true)`, [
      ctx.allOrgs ? 'true' : 'false',
    ]);
    // Platform superuser flag: RLS (app_is_nexus_in_scope) grants cross-org access when set,
    // keeping the DB layer consistent with the PDP's admin.superuser cross-org rule.
    await client.query(`SELECT set_config('app.superuser', $1, true)`, [
      ctx.superuser ? 'true' : 'false',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Privileged context for migrations/seed/system jobs and a narrow set of
 * cross-tenant operations (e.g. resolving which org an email belongs to during
 * login/registration, before an org context exists). Uses the owner role which
 * bypasses RLS — callers MUST scope their own queries explicitly.
 */
export async function withSystemContext<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

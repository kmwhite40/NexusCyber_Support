// Per-customer billing: each organization has its own monthly ticket allocation
// and flat per-ticket overage fee. Utilization is computed live from
// tickets.created_at; org_billing holds only the (per-org) configuration.
// Admin-only — every entry point requires `org.manage`.
import { withSystemContext } from '../db/pool.js';
import { authorize } from '../authz/pdp.js';
import type { Principal } from '../types.js';

export interface BillingSettings {
  organization_id: string;
  plan_name: string;
  monthly_ticket_allocation: number;
  overage_fee_cents: number;
  currency: string;
  updated_at: string | null;
}

const defaults = (organization_id: string): BillingSettings => ({
  organization_id,
  plan_name: 'Standard',
  monthly_ticket_allocation: 0,
  overage_fee_cents: 0,
  currency: 'USD',
  updated_at: null,
});

const COLS = 'organization_id, plan_name, monthly_ticket_allocation, overage_fee_cents, currency, updated_at';

/** Read a customer's billing config (admin-only). Returns sane defaults if unset. */
export async function getSettings(actor: Principal, orgId: string): Promise<BillingSettings> {
  authorize(actor, 'org.manage', { organizationId: orgId });
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query<BillingSettings>(
      `SELECT ${COLS} FROM org_billing WHERE organization_id = $1`,
      [orgId],
    );
    return rows[0] ?? defaults(orgId);
  });
}

export interface BillingInput {
  plan_name: string;
  monthly_ticket_allocation: number;
  overage_fee_cents: number;
  currency: string;
}

/** Upsert a customer's billing config (admin-only). */
export async function setSettings(actor: Principal, orgId: string, input: BillingInput): Promise<BillingSettings> {
  authorize(actor, 'org.manage', { organizationId: orgId });
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query<BillingSettings>(
      `INSERT INTO org_billing (organization_id, plan_name, monthly_ticket_allocation, overage_fee_cents, currency, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (organization_id) DO UPDATE SET
         plan_name = EXCLUDED.plan_name,
         monthly_ticket_allocation = EXCLUDED.monthly_ticket_allocation,
         overage_fee_cents = EXCLUDED.overage_fee_cents,
         currency = EXCLUDED.currency,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by
       RETURNING ${COLS}`,
      [orgId, input.plan_name, input.monthly_ticket_allocation, input.overage_fee_cents, input.currency, actor.id],
    );
    return rows[0];
  });
}

export interface Utilization {
  organization_id: string;
  organization_name: string;
  year: number;
  month: number; // 1-12
  period_start: string;
  period_end: string;
  used: number;
  allocation: number;
  overage: number;
  overage_fee_cents: number;
  amount_cents: number;
  currency: string;
  plan_name: string;
}

/** Compute a customer's utilization + overage charge for a given month (admin-only). */
export async function utilization(actor: Principal, orgId: string, year: number, month: number): Promise<Utilization> {
  authorize(actor, 'org.manage', { organizationId: orgId });
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return withSystemContext(async (sql) => {
    const cfg =
      (await sql.query<BillingSettings>(`SELECT ${COLS} FROM org_billing WHERE organization_id = $1`, [orgId])).rows[0] ??
      defaults(orgId);
    const org = (await sql.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId])).rows[0];
    const used = (
      await sql.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM tickets WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3',
        [orgId, start.toISOString(), end.toISOString()],
      )
    ).rows[0].c;
    const allocation = cfg.monthly_ticket_allocation;
    const overage = Math.max(0, used - allocation);
    const amount_cents = overage * cfg.overage_fee_cents;
    return {
      organization_id: orgId,
      organization_name: org?.name ?? 'Unknown',
      year,
      month,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      used,
      allocation,
      overage,
      overage_fee_cents: cfg.overage_fee_cents,
      amount_cents,
      currency: cfg.currency,
      plan_name: cfg.plan_name,
    };
  });
}

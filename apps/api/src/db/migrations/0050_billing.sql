-- Per-organization billing: a monthly ticket allocation (included in the plan)
-- plus a flat per-ticket overage fee for tickets created beyond the allotment.
-- Utilization is computed live from tickets.created_at; this table only holds config.
CREATE TABLE IF NOT EXISTS org_billing (
  organization_id            uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_name                  text    NOT NULL DEFAULT 'Standard',
  monthly_ticket_allocation  integer NOT NULL DEFAULT 0   CHECK (monthly_ticket_allocation >= 0),
  overage_fee_cents          integer NOT NULL DEFAULT 0   CHECK (overage_fee_cents >= 0),
  currency                   text    NOT NULL DEFAULT 'USD',
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid
);

-- Sensible demo default so the billing portal is immediately meaningful:
-- 15 tickets/month allotment, $25.00 per overage ticket (matches the worked example).
INSERT INTO org_billing (organization_id, plan_name, monthly_ticket_allocation, overage_fee_cents, currency)
SELECT id, 'Demo Plan', 15, 2500, 'USD' FROM organizations WHERE name = 'Demo Corp'
ON CONFLICT (organization_id) DO NOTHING;

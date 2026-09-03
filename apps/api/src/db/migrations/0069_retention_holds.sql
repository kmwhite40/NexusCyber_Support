-- Retention holds: the runbook's 1-year / 7-year obligation, recorded so it can be checked.
--
-- Detection, not enforcement. Nexus never deletes Entra accounts and cannot stop the Azure
-- portal, so a hold cannot be a lock — it is the thing that NOTICES when a retained account
-- disappears early, or when its obligation ends.
--
-- A hold OUTLIVES its ticket and its run, by up to seven years. It therefore denormalizes the
-- account's identity and NULLS its references rather than cascading: tidying a ticket must not
-- destroy the record of an obligation with six years left, because the absence would look
-- exactly like compliance.
CREATE TABLE IF NOT EXISTS retention_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),

  -- Denormalized on purpose. A hold must be able to say WHICH account without joining anything.
  upn text NOT NULL,
  entra_object_id text NOT NULL,
  display_name_at_offboard text,

  retention_class text NOT NULL CHECK (retention_class IN ('standard','privileged')),
  -- WHY it is privileged: which directory roles, which Nexus roles, which elevation grants.
  -- An auditor asking "why is this one seven years?" gets the answer from the row itself.
  classification_basis jsonb NOT NULL DEFAULT '{}'::jsonb,

  offboarded_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,

  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','breached','eligible','disposed')),
  -- Nullable, and only stamped on a SUCCESSFUL check, so a sweeper that has stopped running --
  -- or one that cannot reach the tenant -- is detectable rather than indistinguishable from
  -- "everything is fine".
  last_checked_at timestamptz,

  run_id uuid REFERENCES provisioning_runs(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE retention_holds IS
  'Retention obligations for offboarded accounts (1yr standard / 7yr privileged). Outlives the ticket and run it came from; identity is denormalized and references are ON DELETE SET NULL by design.';

-- The sweep predicate.
CREATE INDEX IF NOT EXISTS retention_holds_sweep_idx
  ON retention_holds (state, retain_until) WHERE state = 'active';

-- One account cannot accumulate duplicate live obligations.
CREATE UNIQUE INDEX IF NOT EXISTS retention_holds_account_live_idx
  ON retention_holds (entra_object_id) WHERE state <> 'disposed';

ALTER TABLE retention_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS retention_holds_isolation ON retention_holds;
CREATE POLICY retention_holds_isolation ON retention_holds FOR ALL
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

-- The catalog item the sweeper raises breach and disposal tickets against.
--
-- DUAL-WRITTEN with seed.ts. migrate runs BEFORE seed, so on a fresh database this INSERT lands
-- first and seed's upsert then finds it; on an existing database this is the only half that runs
-- at all. Neither half alone covers both environments -- that asymmetry is what left 32 catalog
-- items unlinked on every fresh install until it was found.
INSERT INTO service_catalog_items
  (key, name, category, description, ticket_type, owning_tier, requires_approval,
   approver_hint, default_priority, security_class, sla_response_min, sla_resolution_min,
   fulfillment_steps)
VALUES
  ('security.retention_review', 'Account retention review', 'Security',
   'Review a departed account whose retention obligation has expired, or which disappeared before it should have.',
   'service_request', 'Tier2', true, 'Security', 'P3', 'standard', 480, 2880,
   '[{"key":"verify","label":"Verify the account state against the hold record","role":"Tier2","automatable":false},
     {"key":"decide","label":"Decide disposition and record the reason","role":"Tier2","automatable":false},
     {"key":"close","label":"Close the hold","role":"Tier2","automatable":false}]'::jsonb)
ON CONFLICT (key) DO NOTHING;

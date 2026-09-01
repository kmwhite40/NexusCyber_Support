-- Resumable provisioning runs. Retrying creates a NEW run; history is never overwritten,
-- so the tables double as the compliance record of what was done to the directory.

CREATE TABLE IF NOT EXISTS provisioning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','awaiting_cloudpc','succeeded','failed')),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid REFERENCES users(id),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provisioning_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES provisioning_runs(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  position int NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  request jsonb,
  response jsonb,
  graph_object_id text,
  error text,
  attempts int NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS provisioning_runs_awaiting_idx
  ON provisioning_runs (status) WHERE status = 'awaiting_cloudpc';

ALTER TABLE provisioning_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provisioning_runs_isolation ON provisioning_runs;
CREATE POLICY provisioning_runs_isolation ON provisioning_runs
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

INSERT INTO permissions (key, domain, description) VALUES
  ('provisioning.execute', 'integration', 'Preview and execute Entra account provisioning')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'provisioning.execute' FROM roles r WHERE r.key IN ('SuperAdmin','ServiceDeskManager')
ON CONFLICT DO NOTHING;

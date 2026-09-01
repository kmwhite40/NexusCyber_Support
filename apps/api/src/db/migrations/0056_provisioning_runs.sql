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
  -- organization_id denormalized from the parent run; RLS is not inherited through FKs,
  -- so this column enables independent RLS isolation (see approval_steps pattern in 0004).
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS ix_provisioning_steps_org ON provisioning_steps(organization_id);

CREATE INDEX IF NOT EXISTS provisioning_runs_awaiting_idx
  ON provisioning_runs (status) WHERE status = 'awaiting_cloudpc';

-- Row-Level Security: both tables are org-scoped.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provisioning_runs','provisioning_steps']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_isolation ON %1$I;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

INSERT INTO permissions (key, domain, description) VALUES
  ('provisioning.execute', 'integration', 'Preview and execute Entra account provisioning')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'provisioning.execute' FROM roles r WHERE r.key IN ('SuperAdmin','ServiceDeskManager')
ON CONFLICT DO NOTHING;

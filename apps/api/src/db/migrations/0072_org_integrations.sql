-- Per-customer external-integration credentials (Entra/Intune device sync), plus CMDB provenance
-- and sync-run history.
--
-- Secrets are envelope-encrypted at the APP layer: Key Vault is blocked by enclave policy in this
-- environment, so the database holds only ciphertext, IV and auth tag, and the key lives in app
-- config. Nothing stored here is decryptable from the database alone — which is the whole point,
-- and the reason there is deliberately no client_secret text column.

CREATE TABLE IF NOT EXISTS org_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          text NOT NULL,                        -- 'entra_graph'
  tenant_id         text NOT NULL,
  client_id         text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_iv         bytea NOT NULL,
  secret_tag        bytea NOT NULL,
  -- Which key encrypted this row, so a key rotation can re-wrap without guessing.
  key_version       int  NOT NULL DEFAULT 1,
  enabled           boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'unconfigured', -- unconfigured | ok | error
  last_sync_at      timestamptz,
  last_error        text,
  last_sync_stats   jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

COMMENT ON TABLE org_integrations IS
  'Per-customer integration credentials. secret_* columns are AES-256-GCM ciphertext/IV/tag; the key is app config, never in this database.';

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  created_count   int NOT NULL DEFAULT 0,
  updated_count   int NOT NULL DEFAULT 0,
  retired_count   int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'ok',             -- ok | error
  error           text
);
CREATE INDEX IF NOT EXISTS ix_sync_runs_org ON integration_sync_runs(organization_id, started_at DESC);

-- CMDB provenance. Synced devices are source='entra'; anything created by hand stays 'manual' and
-- is never touched by the sync — the default matters, because every CI that already exists was
-- created by hand. external_id holds the Entra azureADDeviceId, which is what makes the upsert
-- idempotent across runs.
ALTER TABLE configuration_items
  ADD COLUMN IF NOT EXISTS source      text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS external_id text;

-- Partial on purpose: manual CIs have no external_id and must not collide with one another.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ci_source_external
  ON configuration_items(organization_id, source, external_id)
  WHERE external_id IS NOT NULL;

-- Tenant isolation, consistent with every other org-scoped table.
ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_integrations_isolation ON org_integrations;
CREATE POLICY org_integrations_isolation ON org_integrations
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

ALTER TABLE integration_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_sync_runs_isolation ON integration_sync_runs;
CREATE POLICY integration_sync_runs_isolation ON integration_sync_runs
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON org_integrations TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_sync_runs TO nexus_app;

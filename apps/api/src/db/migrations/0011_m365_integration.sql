-- M365 GCC integration: notification prefs, integration cursors/state, health
-- checks, and richer delivery records (docs/nexus/06 §K, §L).

-- Per-user email opt-out (minimal preference center; quiet hours/digest are future).
CREATE TABLE notification_preferences (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  email_enabled   boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Key/value cursors for integrations (e.g. inbox delta link, processed message ids).
CREATE TABLE integration_state (
  integration text NOT NULL,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration, key)
);

-- Integration health probe results (docs/nexus/06 §L.8).
CREATE TABLE integration_health_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration text NOT NULL,
  check_name  text NOT NULL,
  status      text NOT NULL,           -- pass | fail | skipped
  detail      jsonb NOT NULL DEFAULT '{}',
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_health_integration_time ON integration_health_checks(integration, checked_at DESC);

-- Richer delivery records.
ALTER TABLE notification_deliveries ADD COLUMN provider_message_id text;
ALTER TABLE notification_deliveries ADD COLUMN attempts int NOT NULL DEFAULT 0;

-- RLS for the org-scoped preferences table (consistent with existing policies).
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_isolation ON notification_preferences
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

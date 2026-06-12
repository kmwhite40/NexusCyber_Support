-- Configurable intake channels (email inbox / portal / widget) per org. The ticket
-- source_channel string can reference one by name; no destructive migration of existing values.
CREATE TABLE channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('email','portal','widget')),
  name             text NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}',
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY channels_isolation ON channels
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON channels TO nexus_app;

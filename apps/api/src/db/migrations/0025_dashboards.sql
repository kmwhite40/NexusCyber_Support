-- Named dashboards with a preset-widget layout. layout = ordered jsonb array of {type}.
-- Seeds a shared default "Operations overview" per existing org; fixed /dashboard remains fallback.
CREATE TABLE dashboards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id    uuid REFERENCES users(id),
  name             text NOT NULL,
  layout           jsonb NOT NULL DEFAULT '[]',
  is_default       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY dashboards_isolation ON dashboards
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON dashboards TO nexus_app;
INSERT INTO dashboards (organization_id, owner_user_id, name, layout, is_default)
SELECT id, NULL, 'Operations overview',
  '[{"type":"kpis"},{"type":"ticket_volume"},{"type":"posture_gauge"},{"type":"top_findings"}]'::jsonb, true
FROM organizations;

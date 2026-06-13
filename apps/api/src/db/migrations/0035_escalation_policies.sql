-- Escalation policies: ordered steps that route an unacknowledged page/alert to the next
-- responder after a delay. Steps are jsonb: [{order,targetType,targetId,delayMinutes}].
CREATE TABLE escalation_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  steps           jsonb NOT NULL DEFAULT '[]',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE escalation_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY escalation_policies_isolation ON escalation_policies
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON escalation_policies TO nexus_app;

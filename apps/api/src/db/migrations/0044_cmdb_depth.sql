-- CMDB depth (ServiceNow parity Phase 2): extensible CI attributes, ownership, and
-- CI-to-CI relationships. Idempotent.

ALTER TABLE configuration_items
  ADD COLUMN IF NOT EXISTS attributes    jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS owner         text,
  ADD COLUMN IF NOT EXISTS support_group text;

CREATE TABLE IF NOT EXISTS ci_relationships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_ci_id    uuid NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  target_ci_id    uuid NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  rel_type        text NOT NULL CHECK (rel_type IN ('depends_on','runs_on','hosts','connects_to','member_of','uses')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_ci_id, target_ci_id, rel_type)
);
CREATE INDEX IF NOT EXISTS ix_ci_rel_source ON ci_relationships(source_ci_id);
CREATE INDEX IF NOT EXISTS ix_ci_rel_target ON ci_relationships(target_ci_id);
CREATE INDEX IF NOT EXISTS ix_ci_rel_org ON ci_relationships(organization_id);

-- Tenant isolation, consistent with every other org-scoped table.
ALTER TABLE ci_relationships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ci_relationships_isolation ON ci_relationships;
CREATE POLICY ci_relationships_isolation ON ci_relationships
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ci_relationships TO nexus_app;

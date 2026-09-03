-- Saved agent work queues (JSM-style). A queue is a named, reusable ticket filter with a
-- sort order. Queues may be global (organization_id NULL, shared by all agents) or
-- org-scoped. SLA-aware sorting orders by the soonest-breaching SLA instance.
CREATE TABLE queues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global
  name            text NOT NULL,
  definition      jsonb NOT NULL DEFAULT '{}',  -- {status?, priority?, unassigned?, tag?}
  order_by        text NOT NULL DEFAULT 'sla' CHECK (order_by IN ('sla','priority','created')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE queues ENABLE ROW LEVEL SECURITY;
CREATE POLICY queues_isolation ON queues
  USING (organization_id IS NULL OR organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON queues TO nexus_app;

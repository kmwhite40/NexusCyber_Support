-- Configurable ticket workflows (JSM parity). A workflow is a set of allowed status
-- transitions for a (ticket_type) scope; global (organization_id NULL) or org-specific.
-- The engine falls back to the built-in default map when no workflow is configured.
CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global
  ticket_type     text NOT NULL,
  name            text NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, ticket_type)
);

CREATE TABLE workflow_transitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  UNIQUE (workflow_id, from_status, to_status)
);
CREATE INDEX ix_workflow_transitions_wf ON workflow_transitions(workflow_id);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflows_isolation ON workflows
  USING (organization_id IS NULL OR organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

-- workflow_transitions inherit visibility from their workflow; no org column, so allow the
-- app role to read/write and rely on the workflows policy + app authz for scoping.
GRANT SELECT, INSERT, UPDATE, DELETE ON workflows, workflow_transitions TO nexus_app;

-- Seed a global default workflow for incidents (mirrors the built-in map) so it is visible
-- and editable via the API. created_by NULL = system-provided.
DO $$
DECLARE wf uuid;
BEGIN
  INSERT INTO workflows (organization_id, ticket_type, name) VALUES (NULL, 'incident', 'Default incident workflow')
  RETURNING id INTO wf;
  INSERT INTO workflow_transitions (workflow_id, from_status, to_status) VALUES
    (wf,'new','triage'),(wf,'new','assigned'),
    (wf,'triage','assigned'),(wf,'triage','in_progress'),
    (wf,'assigned','in_progress'),(wf,'assigned','waiting_customer'),(wf,'assigned','on_hold'),
    (wf,'in_progress','waiting_customer'),(wf,'in_progress','waiting_vendor'),(wf,'in_progress','on_hold'),(wf,'in_progress','resolved'),
    (wf,'waiting_customer','in_progress'),(wf,'waiting_customer','resolved'),
    (wf,'waiting_vendor','in_progress'),
    (wf,'on_hold','in_progress'),
    (wf,'resolved','closed'),(wf,'resolved','reopened'),
    (wf,'reopened','in_progress');
END $$;

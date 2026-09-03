-- Change management + CAB (Change Advisory Board). Normal/emergency changes go through a
-- multi-step CAB approval (reusing approvals + approval_steps from 0004); standard changes
-- are pre-approved. A change has a scheduled window for the change calendar. (docs/nexus/03)
CREATE TABLE changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid REFERENCES tickets(id) ON DELETE SET NULL,
  title           text NOT NULL,
  description     text,
  change_type     text NOT NULL DEFAULT 'normal' CHECK (change_type IN ('standard','normal','emergency')),
  risk            text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','cab_review','approved','scheduled','implementing','review','closed','rejected')),
  window_start    timestamptz,
  window_end      timestamptz,
  implementer_id  uuid REFERENCES users(id),
  backout_plan    text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_changes_status ON changes(status);
CREATE INDEX ix_changes_window ON changes(window_start, window_end);

ALTER TABLE changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY changes_isolation ON changes
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON changes TO nexus_app;

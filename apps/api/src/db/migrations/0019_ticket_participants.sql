-- Ticket participants / watchers / collaborators (JSM parity). @mentions in comments add
-- the mentioned user as a watcher and notify them.
CREATE TABLE ticket_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'watcher' CHECK (role IN ('watcher','collaborator','approver')),
  added_by        uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, user_id)
);
CREATE INDEX ix_ticket_participants_ticket ON ticket_participants(ticket_id);

ALTER TABLE ticket_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_participants_isolation ON ticket_participants
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_participants TO nexus_app;

-- Ticket worklogs / time tracking (JSM parity). Agents log time spent against a ticket;
-- totals feed effort reporting.
CREATE TABLE ticket_worklogs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES users(id),
  minutes         int NOT NULL CHECK (minutes > 0),
  note            text,
  logged_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_worklogs_ticket ON ticket_worklogs(ticket_id);

ALTER TABLE ticket_worklogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_worklogs_isolation ON ticket_worklogs
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_worklogs TO nexus_app;

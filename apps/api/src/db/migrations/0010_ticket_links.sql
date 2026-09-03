-- Ticket linking + parent/child (JSM-style related issues). Underpins incident<->problem
-- <->change association and merge/duplicate handling (docs/nexus/03 §F.7).
ALTER TABLE tickets ADD COLUMN parent_ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL;

CREATE TABLE ticket_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_ticket_id    uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type       text NOT NULL CHECK (link_type IN
                    ('duplicate_of','caused_by','related_to','blocks','child_of','merged_into')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_ticket_id, to_ticket_id, link_type),
  CHECK (from_ticket_id <> to_ticket_id)
);
CREATE INDEX ix_ticket_links_from ON ticket_links(from_ticket_id);
CREATE INDEX ix_ticket_links_to ON ticket_links(to_ticket_id);

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_links_isolation ON ticket_links
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_links TO nexus_app;

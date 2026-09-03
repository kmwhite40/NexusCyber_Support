-- Ticket attachments (tenant, RLS). Bytes live in a BlobStore (local-fs mock here);
-- this table is the metadata + scan-status system-of-record. Infected files are never
-- served (docs/nexus/08 §Q.3 attachment handling, US-013).
CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id      uuid REFERENCES ticket_comments(id) ON DELETE SET NULL,
  filename        text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  scan_status     text NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending','clean','infected','error')),
  storage_key     text NOT NULL,
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_attachments_ticket ON attachments(ticket_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_isolation ON attachments
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO nexus_app;

-- Portal announcements (JSM parity). Banner messages shown to customers (e.g. maintenance
-- windows, incidents). Global (organization_id NULL) or org-scoped, with an active window.
CREATE TABLE announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = all customers
  title           text NOT NULL,
  body            text NOT NULL,
  severity        text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  active          boolean NOT NULL DEFAULT true,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_announcements_active ON announcements(active, starts_at);

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY announcements_isolation ON announcements
  USING (organization_id IS NULL OR organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON announcements TO nexus_app;

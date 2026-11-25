-- Risk acceptance packages: one organization's risks awaiting acceptance, frozen at issue time as
-- a print-ready document an Authorizing Official signs on paper. The snapshot and html are never
-- rewritten; sha256 is the hash of the snapshot as built (jsonb reorders keys, so it is stored).
CREATE TABLE risk_acceptance_packages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  package_number       int NOT NULL,
  reference            text,
  risk_ids             uuid[] NOT NULL,
  snapshot             jsonb NOT NULL,
  html                 text NOT NULL,
  sha256               text NOT NULL,
  status               text NOT NULL CHECK (status IN ('issued','signed','void')),
  void_reason          text,
  generated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  signed_by_name       text,
  signed_by_title      text,
  signed_on            date,
  recorded_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at          timestamptz,
  signed_attachment_id uuid,
  decisions            jsonb,
  UNIQUE (organization_id, package_number)
);
CREATE INDEX ix_risk_acceptance_packages_org ON risk_acceptance_packages(organization_id, generated_at DESC);

ALTER TABLE risk_acceptance_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_acceptance_packages_isolation ON risk_acceptance_packages
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON risk_acceptance_packages TO nexus_app;

-- The signed scan is an attachment of the package rather than of a ticket.
ALTER TABLE attachments ALTER COLUMN ticket_id DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN acceptance_package_id uuid REFERENCES risk_acceptance_packages(id) ON DELETE CASCADE;
ALTER TABLE attachments ADD CONSTRAINT attachments_one_parent CHECK (num_nonnulls(ticket_id, acceptance_package_id) = 1);
CREATE INDEX ix_attachments_acceptance_package ON attachments(acceptance_package_id) WHERE acceptance_package_id IS NOT NULL;

ALTER TABLE risk_acceptance_packages
  ADD CONSTRAINT risk_acceptance_packages_signed_attachment_fk
  FOREIGN KEY (signed_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL;

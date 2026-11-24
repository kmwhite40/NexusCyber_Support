-- Provenance and an idempotency anchor for changes and risks that originate outside Nexus — first use:
-- the one-time import of the retired SharePoint "Change Request" list. Mirrors the
-- tickets.external_ref / external_source pair (0051): unique per org when present, so a
-- re-run of an import updates nothing twice and creates no duplicates. Changes raised in
-- Nexus leave both NULL.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS external_ref    text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS external_source text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_changes_org_external_ref
  ON changes(organization_id, external_ref) WHERE external_ref IS NOT NULL;

-- Same anchor for risks imported from a legacy register (e.g. the SBSFederal spreadsheet), so a
-- re-run skips rows already imported instead of colliding on risk_number.
ALTER TABLE risks ADD COLUMN IF NOT EXISTS external_ref    text;
ALTER TABLE risks ADD COLUMN IF NOT EXISTS external_source text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_risks_org_external_ref
  ON risks(organization_id, external_ref) WHERE external_ref IS NOT NULL;

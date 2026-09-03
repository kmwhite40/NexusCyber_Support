-- Part A: forms subsystem — conditional visibility, sensitive fields, server-sourced options.
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS visible_when jsonb;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS options_source text;

ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN ('text','textarea','number','select','checkbox','date',
                       'user','user_multi','attachment','email','phone'));

-- Part B: PII storage, held apart from tickets.custom_fields so it never rides along on
-- ticket reads, notification payloads, or outbound webhooks. Reads require pii.view and
-- are individually audited (see src/modules/sensitive-fields.ts).
CREATE TABLE IF NOT EXISTS ticket_sensitive_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, key)
);

-- Same org-isolation predicate as every other tenant table (mirrors the api_keys /
-- webhook_* isolation policy in 0051_anchor_integration.sql).
ALTER TABLE ticket_sensitive_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_sensitive_fields_isolation ON ticket_sensitive_fields;
CREATE POLICY ticket_sensitive_fields_isolation ON ticket_sensitive_fields
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

INSERT INTO permissions (key, domain, description) VALUES
  ('pii.view', 'ticketing', 'View personally identifiable information captured on onboarding requests')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'pii.view' FROM roles r WHERE r.key IN ('SuperAdmin', 'ServiceDeskManager')
ON CONFLICT DO NOTHING;

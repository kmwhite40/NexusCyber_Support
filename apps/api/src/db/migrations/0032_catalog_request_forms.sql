-- Catalog request forms: link items to forms, add people-picker/attachment field types,
-- semantic answer routing (maps_to), and seed the "New user creation & provisioning" form.
ALTER TABLE service_catalog_items ADD COLUMN IF NOT EXISTS form_key text;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS maps_to text;

-- Inline CHECK constraints are auto-named <table>_<column>_check.
ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN ('text','textarea','number','select','checkbox','date','user','user_multi','attachment'));

DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key = 'new_user_provisioning' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'new_user_provisioning', 'New user creation & provisioning', 'access_request')
    RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'Raise this request on behalf of', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'system', 'Select a system', 'select', true,
       '["M365 / Entra ID","Azure Government","AWS GovCloud","Jira","ServiceNow","VPN"]', 2, NULL),
    (f, 'reason', 'Tell us why you need an account', 'textarea', false, '[]', 3, 'description'),
    (f, 'manager', 'Manager', 'user', false, '[]', 4, 'manager'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 5, 'approvers'),
    (f, 'attachment', 'Attachment', 'attachment', false, '[]', 6, 'attachment')
  ON CONFLICT (form_id, key) DO UPDATE SET
    label = EXCLUDED.label, data_type = EXCLUDED.data_type, required = EXCLUDED.required,
    options = EXCLUDED.options, position = EXCLUDED.position, maps_to = EXCLUDED.maps_to;
END $$;

UPDATE service_catalog_items SET form_key = 'new_user_provisioning' WHERE key = 'user.provisioning';

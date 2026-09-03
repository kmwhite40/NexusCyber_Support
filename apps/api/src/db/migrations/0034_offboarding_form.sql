-- Offboarding request form. Unlike access requests, the requester (the manager/HR
-- raising it) differs from the person it's about, so the departing user maps to
-- 'affected' (affected-user only); the requester falls back to the submitter.
-- Idempotent.
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='offboarding' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'offboarding', 'Deprovisioning & offboarding', 'access_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'departing_user', 'User to offboard', 'user', true, '[]', 0, 'affected'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'last_day', 'Last working day', 'date', true, '[]', 2, NULL),
    (f, 'reason', 'Reason / notes', 'textarea', false, '[]', 3, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 4, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

UPDATE service_catalog_items SET form_key = 'offboarding' WHERE key = 'user.offboarding';

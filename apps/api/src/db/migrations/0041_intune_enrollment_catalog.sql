-- End-user "User Device Intune Enrollment" service-catalog item + request form.
-- Distinct from the agent-facing 'device.enrollment' item: this is the self-service
-- request an end user raises to enroll their own device via Company Portal. Pairs with
-- the end-user Intune Enrollment guide (Company Portal + Outlook Classic for GovCloud).
-- Idempotent.

INSERT INTO service_catalog_items
  (key,name,category,description,ticket_type,owning_tier,escalates_to,requires_approval,
   approver_hint,default_priority,security_class,sla_response_min,sla_resolution_min,fulfillment_steps)
VALUES (
  'device.intune_enrollment',
  'User Device Intune Enrollment',
  'Devices & Endpoints',
  'Enroll your Windows, macOS, iOS, or Android device in Microsoft Intune using the Company Portal app so you can securely access work email and apps. For Microsoft 365 in GovCloud, use Outlook (Classic) only.',
  'service_request',
  'Tier 2 — M365 Administrator',
  'Security Operations',
  false,
  NULL,
  'P3',
  'standard',
  60,
  480,
  '[
    {"key":"triage","label":"Verify user, device platform (Windows/macOS/iOS/Android) & ownership (corporate/BYOD)","role":"Tier1","automatable":false},
    {"key":"guide","label":"Share Company Portal enrollment steps (search \"Company Portal\", install, sign in)","role":"Tier1","automatable":false},
    {"key":"enroll","label":"Confirm device enrolled & marked compliant in Intune","role":"Tier2","automatable":true},
    {"key":"email","label":"Set up work email using Outlook (Classic) — required for M365 in GovCloud","role":"Tier2","automatable":true},
    {"key":"verify","label":"Confirm device compliant + required apps deployed","role":"Tier2","automatable":false},
    {"key":"notify","label":"Notify user with first-run / sign-in steps","role":"Tier2","automatable":true}
  ]'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  name=EXCLUDED.name, category=EXCLUDED.category, description=EXCLUDED.description,
  owning_tier=EXCLUDED.owning_tier, escalates_to=EXCLUDED.escalates_to,
  requires_approval=EXCLUDED.requires_approval, fulfillment_steps=EXCLUDED.fulfillment_steps,
  sla_response_min=EXCLUDED.sla_response_min, sla_resolution_min=EXCLUDED.sla_resolution_min;

-- Guided request form for the end user.
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='device_intune_enrollment' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'device_intune_enrollment', 'User Device Intune Enrollment', 'service_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'summary',     'Summary',                  'text',     true,  '[]', 0, 'subject'),
    (f, 'platform',    'Device platform',          'select',   true,  '["Windows","macOS","iOS","Android"]', 1, NULL),
    (f, 'ownership',   'Device ownership',         'select',   true,  '["Corporate-owned","Personal (BYOD)"]', 2, NULL),
    (f, 'device_name', 'Device name / asset tag',  'text',     false, '[]', 3, NULL),
    (f, 'notes',       'Notes (anything we should know)', 'textarea', false, '[]', 4, 'description')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

UPDATE service_catalog_items SET form_key = 'device_intune_enrollment' WHERE key = 'device.intune_enrollment';

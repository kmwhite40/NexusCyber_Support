-- Structured intake forms for the M365 offboard + security/outage report catalog items
-- (added in 0030). Uses the request_forms / form_fields system. Idempotent.
-- maps_to links a field to a ticket attribute (subject/description/affected/approvers);
-- other fields are captured into the ticket's custom_fields.

-- 1) M365 — Offboard departing user
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='m365_offboard' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'm365_offboard', 'M365 — Offboard departing user', 'service_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'departing_user',    'Terminated / departing employee',      'user',     true,  '[]', 0, 'affected'),
    (f, 'summary',           'Summary',                              'text',     true,  '[]', 1, 'subject'),
    (f, 'offboard_type',     'Offboard type',                        'select',   true,  '["Voluntary","Involuntary","Security incident"]', 2, NULL),
    (f, 'last_day',          'Last working day',                     'date',     true,  '[]', 3, NULL),
    (f, 'disable_effective', 'Disable account effective date',       'date',     true,  '[]', 4, NULL),
    (f, 'data_disposition',  'Mailbox & data disposition',           'select',   true,  '["Convert to shared mailbox","Delegate access to manager","Delete all user data after retention","Preserve on legal hold"]', 5, NULL),
    (f, 'forward_to',        'Forward email to (optional)',          'user',     false, '[]', 6, NULL),
    (f, 'hard_delete_date',  'Scheduled hard-delete date',           'date',     false, '[]', 7, NULL),
    (f, 'reclaim_licenses',  'Reclaim assigned licenses',            'checkbox', false, '[]', 8, NULL),
    (f, 'device_disposition','Device disposition',                   'select',   false, '["Wipe","Retrieve","Reassign","None"]', 9, NULL),
    (f, 'legal_hold',        'Apply legal / litigation hold',        'checkbox', false, '[]', 10, NULL),
    (f, 'manager',           'Manager / approver of record',         'user',     false, '[]', 11, NULL),
    (f, 'notes',             'Additional notes',                     'textarea', false, '[]', 12, 'description'),
    (f, 'approvers',         'Approvers',                            'user_multi',false,'[]', 13, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='m365_offboard' WHERE key='m365.offboard';

-- 2) Report a security incident
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='security_incident' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'security_incident', 'Report a security incident', 'incident') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'summary',       'What happened?',                 'text',       true,  '[]', 0, 'subject'),
    (f, 'incident_type', 'Incident type',                  'select',     true,  '["Account compromise","Lost or stolen device","Data exposure","Malware","Phishing fallout","Other"]', 1, NULL),
    (f, 'affected_user', 'Affected user (optional)',       'user',       false, '[]', 2, 'affected'),
    (f, 'when_detected', 'When was it detected?',          'date',       false, '[]', 3, NULL),
    (f, 'impact',        'Impact / what is at risk',       'textarea',   true,  '[]', 4, 'description'),
    (f, 'evidence',      'Evidence (logs, screenshots)',   'attachment', false, '[]', 5, NULL)
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='security_incident' WHERE key='security.incident_report';

-- 3) Report a service outage
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='service_outage' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'service_outage', 'Report a service outage', 'incident') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'service',        'Affected service / application',  'text',     true,  '[]', 0, 'subject'),
    (f, 'impact_scope',   'Who is affected?',                'select',   true,  '["All users","Multiple users","A team or site","A single user"]', 1, NULL),
    (f, 'symptoms',       'Symptoms / what you see',         'textarea', true,  '[]', 2, 'description'),
    (f, 'started_at',     'When did it start?',              'date',     false, '[]', 3, NULL),
    (f, 'business_impact','Business impact',                 'select',   false, '["Critical — work stopped","High — major degradation","Medium — workaround exists","Low"]', 4, NULL)
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='service_outage' WHERE key='ops.service_outage';

-- 4) Report suspected phishing
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='phishing_report' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'phishing_report', 'Report suspected phishing', 'incident') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'summary',     'Subject line of the suspicious email', 'text',       true,  '[]', 0, 'subject'),
    (f, 'sender',      'Sender address',                       'text',       true,  '[]', 1, NULL),
    (f, 'received_at', 'When did you receive it?',             'date',       false, '[]', 2, NULL),
    (f, 'clicked',     'Did anyone click a link or reply?',    'checkbox',   false, '[]', 3, NULL),
    (f, 'details',     'What looks suspicious?',               'textarea',   false, '[]', 4, 'description'),
    (f, 'email_file',  'Attach the email (.eml or .msg)',      'attachment', false, '[]', 5, NULL)
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='phishing_report' WHERE key='security.phishing_report';

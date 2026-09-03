-- Custom request forms for additional access/privileged catalog items, using the generic
-- renderer (field types + maps_to from 0032). Each form: on-behalf-of -> requester,
-- summary -> subject, item-specific fields, justification -> description, approvers -> steps.
-- Idempotent: re-running upserts fields and re-links items.

-- group.membership_change -> group_membership
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='group_membership' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'group_membership', 'Group membership change', 'access_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'Member', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'group_name', 'Group name', 'text', true, '[]', 2, NULL),
    (f, 'action', 'Add or remove', 'select', true, '["Add","Remove"]', 3, NULL),
    (f, 'reason', 'Justification', 'textarea', false, '[]', 4, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 5, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

-- m365.guest_access -> m365_guest_access
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='m365_guest_access' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'm365_guest_access', 'External (B2B) guest access', 'access_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'Sponsor (internal)', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'guest_email', 'Guest email', 'text', true, '[]', 2, NULL),
    (f, 'duration', 'Access duration', 'select', true, '["30 days","60 days","90 days","1 year"]', 3, NULL),
    (f, 'reason', 'Business justification', 'textarea', false, '[]', 4, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 5, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

-- azure.pim_role -> azure_pim_role
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='azure_pim_role' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'azure_pim_role', 'Azure RBAC / PIM eligible role', 'access_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'User', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'azure_role', 'Azure role', 'text', true, '[]', 2, NULL),
    (f, 'scope', 'Scope (subscription / resource group)', 'text', true, '[]', 3, NULL),
    (f, 'duration', 'Activation duration', 'select', true, '["1 hour","4 hours","8 hours","1 day"]', 4, NULL),
    (f, 'reason', 'Justification', 'textarea', false, '[]', 5, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 6, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

-- azure.keyvault_access -> azure_keyvault_access
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='azure_keyvault_access' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'azure_keyvault_access', 'Key Vault access', 'access_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'User', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'vault_name', 'Key Vault name', 'text', true, '[]', 2, NULL),
    (f, 'access_level', 'Access level', 'select', true, '["Read secrets","Read keys","Manage"]', 3, NULL),
    (f, 'reason', 'Justification', 'textarea', false, '[]', 4, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 5, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

-- aws.identity_center -> aws_identity_center
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='aws_identity_center' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'aws_identity_center', 'AWS IAM Identity Center permission set', 'access_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'User', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'permission_set', 'Permission set', 'text', true, '[]', 2, NULL),
    (f, 'account', 'AWS account (name or id)', 'text', true, '[]', 3, NULL),
    (f, 'reason', 'Justification', 'textarea', false, '[]', 4, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 5, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

-- license.assignment -> license_assignment
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='license_assignment' AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, 'license_assignment', 'License assignment / reassignment', 'service_request') RETURNING id INTO f;
  END IF;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f, 'on_behalf_of', 'User', 'user', true, '[]', 0, 'requester'),
    (f, 'summary', 'Summary', 'text', true, '[]', 1, 'subject'),
    (f, 'sku', 'License (SKU)', 'select', true, '["M365 E3","M365 E5","M365 F3","Power BI Pro","Project Plan 3","Visio Plan 2"]', 2, NULL),
    (f, 'reason', 'Justification', 'textarea', false, '[]', 3, 'description'),
    (f, 'approvers', 'Approvers', 'user_multi', false, '[]', 4, 'approvers')
  ON CONFLICT (form_id, key) DO UPDATE SET label=EXCLUDED.label, data_type=EXCLUDED.data_type,
    required=EXCLUDED.required, options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to;
END $$;

-- Link catalog items to their forms.
UPDATE service_catalog_items SET form_key = CASE key
  WHEN 'group.membership_change' THEN 'group_membership'
  WHEN 'm365.guest_access'       THEN 'm365_guest_access'
  WHEN 'azure.pim_role'          THEN 'azure_pim_role'
  WHEN 'azure.keyvault_access'   THEN 'azure_keyvault_access'
  WHEN 'aws.identity_center'     THEN 'aws_identity_center'
  WHEN 'license.assignment'      THEN 'license_assignment'
END
WHERE key IN ('group.membership_change','m365.guest_access','azure.pim_role',
              'azure.keyvault_access','aws.identity_center','license.assignment');

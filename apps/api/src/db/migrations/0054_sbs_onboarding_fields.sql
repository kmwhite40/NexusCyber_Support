-- SBS "New User Computer/Network Access Form" fields on the existing user_onboarding form.
-- Positions: 0037 seeded the original 15 fields at positions 0-14 (on_behalf_of .. approvers).
-- These SBS fields are appended after that range, starting at position 15, so the two field
-- sets render in distinct, non-colliding blocks instead of scrambling the original ordering.
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='user_onboarding' AND organization_id IS NULL;
  IF f IS NULL THEN RAISE NOTICE 'user_onboarding form missing; 0037 must run first'; RETURN; END IF;

  -- The single free-text name is superseded by split legal-name fields.
  DELETE FROM form_fields WHERE form_id=f AND key='new_employee_name';

  -- The original 'manager' picker is superseded by 'supervisor' below, the single
  -- field carrying maps_to='manager' (required, label-matched to the SBS PDF).
  DELETE FROM form_fields WHERE form_id=f AND key='manager';

  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to,visible_when,sensitive,options_source) VALUES
    (f,'legal_last_name','Legal last name','text',true,'[]',15,NULL,NULL,false,NULL),
    (f,'legal_first_name','Legal first name','text',true,'[]',16,'subject',NULL,false,NULL),
    (f,'middle_name','Middle name','text',false,'[]',17,NULL,NULL,false,NULL),
    (f,'preferred_first_name','Preferred first name','text',false,'[]',18,NULL,NULL,false,NULL),
    (f,'access_type','Access type','select',true,'["Permanent","Temporary"]',19,NULL,NULL,false,NULL),
    (f,'hire_type','Hire type','select',true,'["Direct Hire","Temporary","Consultant"]',20,NULL,NULL,false,NULL),
    (f,'employee_id','Employee ID','text',false,'[]',21,NULL,NULL,false,NULL),
    (f,'request_kind','Request kind','select',true,'["New Hire","Replacement"]',22,NULL,NULL,false,NULL),
    (f,'replacement_for','Replacement for','user',false,'[]',23,NULL,'{"field":"request_kind","equals":"Replacement"}',false,NULL),
    (f,'end_date','End date','date',true,'[]',24,NULL,'{"field":"access_type","equals":"Temporary"}',false,NULL),
    (f,'supervisor','Supervisor','user',true,'[]',25,'manager',NULL,false,NULL),
    (f,'work_location','Work location','select',true,'["Work from Home - Permanent","Work from Home - Temporary","On Site"]',26,NULL,NULL,false,NULL),
    (f,'duty_location','Duty location','text',false,'[]',27,NULL,NULL,false,NULL),
    (f,'email_account','Email account','select',true,'["Create New","Change Existing"]',28,NULL,NULL,false,NULL),
    (f,'cloud_pc_policy','Cloud PC provisioning policy','select',false,'[]',29,NULL,NULL,false,'cloudpc_policies'),
    (f,'personal_email','Personal email address','email',false,'[]',30,NULL,NULL,true,NULL),
    (f,'cell_phone','Cell phone number','phone',false,'[]',31,NULL,NULL,true,NULL),
    (f,'home_address_street','Home address (street)','text',false,'[]',32,NULL,'{"field":"work_location","in":["Work from Home - Permanent","Work from Home - Temporary"]}',true,NULL),
    (f,'home_address_csz','Home address (city, state, ZIP)','text',false,'[]',33,NULL,'{"field":"work_location","in":["Work from Home - Permanent","Work from Home - Temporary"]}',true,NULL)
  ON CONFLICT (form_id,key) DO UPDATE SET
    label=EXCLUDED.label, data_type=EXCLUDED.data_type, required=EXCLUDED.required,
    options=EXCLUDED.options, position=EXCLUDED.position, maps_to=EXCLUDED.maps_to,
    visible_when=EXCLUDED.visible_when, sensitive=EXCLUDED.sensitive,
    options_source=EXCLUDED.options_source;
END $$;

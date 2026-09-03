-- Comprehensive onboarding intake + forms for the catalog items that had none.
-- Uses request_forms / form_fields. Idempotent. A helper keeps the 9 forms compact.
CREATE OR REPLACE FUNCTION pg_temp.ensure_form(p_key text, p_name text, p_ttype text)
RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key=p_key AND organization_id IS NULL;
  IF f IS NULL THEN
    INSERT INTO request_forms (organization_id, key, name, ticket_type)
    VALUES (NULL, p_key, p_name, p_ttype) RETURNING id INTO f;
  ELSE
    UPDATE request_forms SET name=p_name, ticket_type=p_ttype WHERE id=f;
  END IF;
  RETURN f;
END $fn$;

-- 1) New user onboarding (comprehensive) — link user.provisioning
DO $$
DECLARE f uuid := pg_temp.ensure_form('user_onboarding','New user creation & provisioning','service_request');
BEGIN
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position, maps_to) VALUES
    (f,'on_behalf_of','Raise on behalf of (requester)','user',true,'[]',0,'requester'),
    (f,'new_employee_name','New employee full name','text',true,'[]',1,'subject'),
    (f,'start_date','Start date','date',true,'[]',2,NULL),
    (f,'job_title','Job title','text',false,'[]',3,NULL),
    (f,'department','Department','text',false,'[]',4,NULL),
    (f,'employment_type','Employment type','select',false,'["Full-time","Part-time","Contractor","Intern"]',5,NULL),
    (f,'location','Office / location','text',false,'[]',6,NULL),
    (f,'manager','Manager','user',false,'[]',7,'manager'),
    (f,'copy_from','Copy access from (mirror user)','user',false,'[]',8,NULL),
    (f,'license_bundle','License bundle','select',false,'["Microsoft 365 E3","Microsoft 365 E5","Microsoft 365 F3","Business Premium","None"]',9,NULL),
    (f,'security_groups','Security / distribution groups','textarea',false,'[]',10,NULL),
    (f,'hardware','Hardware needed','select',false,'["Laptop","Desktop","None","Reuse existing"]',11,NULL),
    (f,'mfa_method','MFA / sign-in method','select',false,'["Authenticator app","FIDO2 security key","Phone"]',12,NULL),
    (f,'notes','Additional notes','textarea',false,'[]',13,'description'),
    (f,'approvers','Approvers','user_multi',false,'[]',14,'approvers')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='user_onboarding' WHERE key='user.provisioning';

-- 2) Account unlock
DO $$
DECLARE f uuid := pg_temp.ensure_form('account_unlock','Account unlock','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'account','Account to unlock','user',true,'[]',0,'affected'),
    (f,'summary','Summary','text',true,'[]',1,'subject'),
    (f,'reason','Why is it locked? (optional)','textarea',false,'[]',2,'description'),
    (f,'verified_identity','Identity verified (anti social-engineering)','checkbox',false,'[]',3,NULL)
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='account_unlock' WHERE key='account.unlock';

-- 3) Password reset
DO $$
DECLARE f uuid := pg_temp.ensure_form('password_reset','Password reset','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'account','Account needing reset','user',true,'[]',0,'affected'),
    (f,'summary','Summary','text',true,'[]',1,'subject'),
    (f,'delivery','Deliver new credential via','select',false,'["Verified phone","Manager","In person"]',2,NULL),
    (f,'force_change','Force change at next sign-in','checkbox',false,'[]',3,NULL),
    (f,'notes','Notes','textarea',false,'[]',4,'description')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='password_reset' WHERE key='account.password_reset';

-- 4) AWS GovCloud account / OU provisioning
DO $$
DECLARE f uuid := pg_temp.ensure_form('aws_account_provisioning','AWS GovCloud account / OU provisioning','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'summary','Account / workload name','text',true,'[]',0,'subject'),
    (f,'ou','Target OU / environment','select',true,'["Sandbox","Dev","Test","Prod","Security"]',1,NULL),
    (f,'account_email','Root account email','text',false,'[]',2,NULL),
    (f,'budget','Monthly budget (USD)','number',false,'[]',3,NULL),
    (f,'compliance','Compliance baseline','select',false,'["FedRAMP Moderate","FedRAMP High","IL2","IL4","IL5"]',4,NULL),
    (f,'justification','Justification','textarea',true,'[]',5,'description'),
    (f,'approvers','Approvers','user_multi',false,'[]',6,'approvers')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='aws_account_provisioning' WHERE key='aws.account_provisioning';

-- 5) AWS S3 secure bucket
DO $$
DECLARE f uuid := pg_temp.ensure_form('aws_s3_bucket','AWS S3 bucket provisioning (gov baseline)','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'summary','Bucket purpose / name','text',true,'[]',0,'subject'),
    (f,'account','AWS account / environment','text',true,'[]',1,NULL),
    (f,'data_class','Data classification','select',true,'["Public","Internal","Confidential","CUI"]',2,NULL),
    (f,'encryption','Encryption','select',false,'["SSE-KMS (customer CMK)","SSE-S3"]',3,NULL),
    (f,'block_public','Block all public access','checkbox',false,'[]',4,NULL),
    (f,'justification','Justification','textarea',false,'[]',5,'description')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='aws_s3_bucket' WHERE key='aws.s3_secure_bucket';

-- 6) Azure Gov landing zone
DO $$
DECLARE f uuid := pg_temp.ensure_form('azure_landing_zone','Azure Gov landing-zone / resource provisioning','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'summary','Workload / landing-zone name','text',true,'[]',0,'subject'),
    (f,'subscription','Target subscription / management group','text',true,'[]',1,NULL),
    (f,'environment','Environment','select',true,'["Sandbox","Dev","Test","Prod"]',2,NULL),
    (f,'region','Azure Gov region','select',false,'["usgovvirginia","usgovtexas","usgovarizona"]',3,NULL),
    (f,'compliance','Compliance baseline','select',false,'["FedRAMP High","IL4","IL5"]',4,NULL),
    (f,'justification','Justification','textarea',true,'[]',5,'description'),
    (f,'approvers','Approvers','user_multi',false,'[]',6,'approvers')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='azure_landing_zone' WHERE key='azure.landing_zone';

-- 7) Purview DLP / sensitivity-label exception
DO $$
DECLARE f uuid := pg_temp.ensure_form('purview_dlp_exception','Purview DLP / sensitivity-label exception','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'requesting_user','Requesting user','user',true,'[]',0,'affected'),
    (f,'summary','What is being blocked?','text',true,'[]',1,'subject'),
    (f,'policy','DLP policy / label','text',true,'[]',2,NULL),
    (f,'scope','Exception scope','select',true,'["One-time","User","Group","Site"]',3,NULL),
    (f,'duration','Duration','select',false,'["24 hours","7 days","30 days","Permanent"]',4,NULL),
    (f,'justification','Business justification','textarea',true,'[]',5,'description'),
    (f,'approvers','Approvers','user_multi',false,'[]',6,'approvers')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='purview_dlp_exception' WHERE key='m365.purview_dlp_exception';

-- 8) Shared mailbox & distribution list
DO $$
DECLARE f uuid := pg_temp.ensure_form('shared_mailbox','Shared mailbox & distribution list provisioning','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'summary','Mailbox / list display name','text',true,'[]',0,'subject'),
    (f,'type','Type','select',true,'["Shared mailbox","Distribution list","Microsoft 365 group"]',1,NULL),
    (f,'address','Email address','text',true,'[]',2,NULL),
    (f,'members','Members / who needs access','user_multi',false,'[]',3,NULL),
    (f,'owner','Owner','user',false,'[]',4,NULL),
    (f,'send_as','Grant Send As','checkbox',false,'[]',5,NULL),
    (f,'notes','Notes','textarea',false,'[]',6,'description')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='shared_mailbox' WHERE key='m365.shared_mailbox';

-- 9) Remote support session
DO $$
DECLARE f uuid := pg_temp.ensure_form('remote_session','Remote support (business hours)','service_request');
BEGIN
  INSERT INTO form_fields (form_id,key,label,data_type,required,options,position,maps_to) VALUES
    (f,'user','User needing help','user',true,'[]',0,'affected'),
    (f,'summary','Issue summary','text',true,'[]',1,'subject'),
    (f,'device','Device / hostname','text',false,'[]',2,NULL),
    (f,'availability','Best time to connect','text',false,'[]',3,NULL),
    (f,'details','Describe the issue','textarea',true,'[]',4,'description')
  ON CONFLICT (form_id,key) DO UPDATE SET label=EXCLUDED.label,data_type=EXCLUDED.data_type,required=EXCLUDED.required,options=EXCLUDED.options,position=EXCLUDED.position,maps_to=EXCLUDED.maps_to;
END $$;
UPDATE service_catalog_items SET form_key='remote_session' WHERE key='support.remote_session';

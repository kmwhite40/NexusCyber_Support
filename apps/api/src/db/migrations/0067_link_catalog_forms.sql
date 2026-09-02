-- Link catalog items to their request forms on an EXISTING database.
--
-- The DUAL-WRITE half that seed.ts cannot cover, and vice versa:
--
--   seed.ts (this same mapping) is for a FRESH database. Migrations run BEFORE seed there, so
--   the catalog rows do not exist yet and an UPDATE here matches nothing.
--
--   THIS migration is for a database that already has the rows — production, where 16 active
--   catalog items sit with form_key NULL. Running seed there instead would be far too blunt: it
--   DELETEs and rebuilds every role's permissions and overwrites every catalog item's name, SLA
--   and fulfilment steps, discarding any customisation.
--
-- Why it matters: createRequest validates answers against the linked form's fields. With no form
-- it drops EVERY answer as unknown and stores custom_fields = {}. Nothing errors; the
-- requester's input simply vanishes.
--
-- Same discipline as the seeded KB articles: edit one half, edit the other, or the invariant test
-- in test/integration/catalog-form-links.int.test.ts fails.
--
-- Idempotent, and guarded on the form actually existing — a form_key pointing at a missing form
-- behaves exactly like NULL while looking correct in the data.
UPDATE service_catalog_items sci
   SET form_key = v.form_key
  FROM (VALUES
    ('account.password_reset','password_reset'),
    ('account.unlock','account_unlock'),
    ('aws.account_provisioning','aws_account_provisioning'),
    ('aws.identity_center','aws_identity_center'),
    ('aws.s3_secure_bucket','aws_s3_bucket'),
    ('azure.keyvault_access','azure_keyvault_access'),
    ('azure.landing_zone','azure_landing_zone'),
    ('azure.pim_role','azure_pim_role'),
    ('device.intune_enrollment','device_intune_enrollment'),
    ('group.membership_change','group_membership'),
    ('license.assignment','license_assignment'),
    ('m365.guest_access','m365_guest_access'),
    ('m365.offboard','m365_offboard'),
    ('m365.purview_dlp_exception','purview_dlp_exception'),
    ('m365.shared_mailbox','shared_mailbox'),
    ('ops.service_outage','service_outage'),
    ('security.incident_report','security_incident'),
    ('security.phishing_report','phishing_report'),
    ('support.remote_session','remote_session'),
    ('user.offboarding','offboarding'),
    ('user.provisioning','user_onboarding')
  ) AS v(item_key, form_key)
 WHERE sci.key = v.item_key
   AND sci.form_key IS DISTINCT FROM v.form_key
   AND EXISTS (
     SELECT 1 FROM request_forms rf
      WHERE rf.key = v.form_key AND rf.organization_id IS NULL
   );

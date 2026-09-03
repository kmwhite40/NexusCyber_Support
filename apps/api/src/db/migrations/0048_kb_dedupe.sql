-- Remove the three cross-space duplicate KB articles (same title in two spaces),
-- keeping one canonical copy of each. These accrued from seed history (MFA in both
-- Security and Service Desk) and from the Help Desk batch overlapping Service Desk.
-- Idempotent.

-- 1) "Set up multi-factor authentication (MFA)": keep Security (SEC), drop the Service Desk copy.
DELETE FROM kb_pages
 WHERE organization_id IS NULL
   AND title = 'Set up multi-factor authentication (MFA)'
   AND space_id IN (SELECT id FROM kb_spaces WHERE organization_id IS NULL AND key = 'SD');

-- 2) "Unlock your account": keep Service Desk (SD), drop the Help Desk copy.
DELETE FROM kb_pages
 WHERE organization_id IS NULL
   AND title = 'Unlock your account'
   AND space_id IN (SELECT id FROM kb_spaces WHERE organization_id IS NULL AND key = 'helpdesk');

-- 3) "Install approved software (Company Portal)": keep Service Desk (SD), drop the Help Desk copy.
DELETE FROM kb_pages
 WHERE organization_id IS NULL
   AND title = 'Install approved software (Company Portal)'
   AND space_id IN (SELECT id FROM kb_spaces WHERE organization_id IS NULL AND key = 'helpdesk');

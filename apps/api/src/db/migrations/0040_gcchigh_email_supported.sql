-- GCC High Graph email is validated in production: the anchor-support@ shared
-- mailbox sends via Microsoft Graph Mail.Send (application permission, admin
-- consented). Mark the email channel 'supported' for the gcchigh cloud so the
-- notification dispatcher actually delivers email there (it gates on === 'supported';
-- the previous 'requires_validation' silently routed all email to the fallback).
UPDATE cloud_environments
   SET capability_matrix = jsonb_set(capability_matrix, '{email}', '"supported"')
 WHERE cloud = 'gcchigh';

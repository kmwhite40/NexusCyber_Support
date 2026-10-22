-- Point the shipped KB articles at the Azure Government self-service password reset portal.
--
-- 0045–0049 linked GCC High users to passwordreset.microsoftonline.us. The Government SSPR
-- portal is passwordreset.activedirectory.windowsazure.us — the same address the login page's
-- "Locked out?" link now defaults to (config.ts SSPR_DEFAULT.gov).
--
-- Scope: organization_id IS NULL only. A customer-authored article is their content and is not
-- rewritten here. Idempotent: a second run finds nothing to replace. `tsv` is a generated
-- column, so search picks up the new text without further work.
UPDATE kb_pages
   SET body = replace(body, 'https://passwordreset.microsoftonline.us', 'https://passwordreset.activedirectory.windowsazure.us'),
       updated_at = now()
 WHERE organization_id IS NULL
   AND body LIKE '%https://passwordreset.microsoftonline.us%';

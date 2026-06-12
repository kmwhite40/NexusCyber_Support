-- Enable email as a SUPPORTED notification channel for GCC (docs/nexus/06 §L.7).
-- In gov tenants Teams is typically not validated, so notifications default to
-- email + portal. The router reads cloud_environments at runtime, so this makes
-- gcc-tenant notifications route to email instead of substituting to portal-only.
UPDATE cloud_environments
   SET capability_matrix = jsonb_set(capability_matrix, '{email}', '"supported"'),
       updated_at = now()
 WHERE cloud = 'gcc';

-- Make platform-superuser cross-org access consistent at the DB layer. The PDP grants
-- admin.superuser cross-org scope (0029), but RLS still keyed nexus access solely off
-- app.assigned_orgs — and a SuperAdmin's bootstrap role-assignment is org-NULL, so its
-- assigned_orgs is empty and it could read NO tenant data. Every tenant RLS policy funnels
-- through app_is_nexus_in_scope(), so allowing the app.superuser GUC here grants cross-org
-- access to all of them at once, matching the app-layer rule.
CREATE OR REPLACE FUNCTION app_is_nexus_in_scope(target_org uuid) RETURNS boolean AS $$
  SELECT current_setting('app.plane', true) = 'nexus'
     AND (
       current_setting('app.superuser', true) = 'true'
       OR target_org = ANY (
         string_to_array(NULLIF(current_setting('app.assigned_orgs', true), ''), ',')::uuid[]
       )
     );
$$ LANGUAGE sql STABLE;

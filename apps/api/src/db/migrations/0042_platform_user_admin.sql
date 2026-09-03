-- Platform User Administration (Phase 1).
--
-- 1) New permission `admin.users.manage` — administer platform (nexus) staff accounts
--    and their organization scope. Granted to SuperAdmin (full) and ServiceDeskManager
--    (delegated, limited to their own org scope by the app layer).
-- 2) Generalize the nexus RLS scope check so an "all organizations" grant is expressible
--    WITHOUT full platform-superuser. A nexus role assignment with organization_id IS NULL
--    is interpreted as "this role applies to every org"; the API sets app.all_orgs='true'
--    for such principals, and the policy honors it. SuperAdmin (app.superuser) is unchanged.
-- Idempotent.

INSERT INTO permissions (key, domain, description) VALUES
  ('admin.users.manage', 'platform_admin', 'Administer platform (nexus) staff accounts and their organization scope')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'admin.users.manage' FROM roles r WHERE r.key IN ('SuperAdmin', 'ServiceDeskManager')
  ON CONFLICT DO NOTHING;

-- Generalized nexus scope: superuser OR all-orgs grant OR explicit per-org assignment.
CREATE OR REPLACE FUNCTION app_is_nexus_in_scope(target_org uuid) RETURNS boolean AS $$
  SELECT current_setting('app.plane', true) = 'nexus'
     AND (
       current_setting('app.superuser', true) = 'true'
       OR current_setting('app.all_orgs', true) = 'true'
       OR target_org = ANY (
         string_to_array(NULLIF(current_setting('app.assigned_orgs', true), ''), ',')::uuid[]
       )
     );
$$ LANGUAGE sql STABLE;

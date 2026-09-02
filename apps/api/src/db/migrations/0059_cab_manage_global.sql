-- CAB global-scope guard. cab_boards / change_blackouts / change_templates rows with
-- organization_id IS NULL are the GLOBAL defaults inherited by every organization, and
-- 0052's RLS policy deliberately makes them readable (and therefore writable) from every
-- org context. `cab.manage` alone must not be enough to rewrite or delete them: a
-- per-customer admin holding cab.manage could otherwise destroy the platform-wide default
-- board, blackout windows, or templates for every tenant.
--
-- This adds the platform-wide grant the app layer now requires for any create/update/delete
-- of an org-NULL CAB row. Idempotent.

INSERT INTO permissions (key, domain) VALUES ('cab.manage.global', 'change')
  ON CONFLICT (key) DO NOTHING;

-- Granted only to roles that already hold the platform superuser wildcard. Additional
-- platform (all-orgs) administrators can be granted it explicitly without admin.superuser.
INSERT INTO role_permissions (role_id, permission_key)
  SELECT DISTINCT rp.role_id, 'cab.manage.global'
    FROM role_permissions rp
   WHERE rp.permission_key = 'admin.superuser'
  ON CONFLICT DO NOTHING;

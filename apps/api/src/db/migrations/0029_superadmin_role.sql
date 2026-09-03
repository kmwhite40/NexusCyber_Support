-- Platform SuperAdmin role (admin.superuser wildcard) + bootstrap the initial platform
-- administrators. These are nexus-plane, SSO-only users (no password); they sign in via
-- the agent Entra app and gain full account/customer management. admin.superuser is a
-- wildcard verb in the PDP and (as of this release) also grants cross-org scope.
INSERT INTO permissions (key, domain)
  VALUES ('admin.superuser', 'platform_admin')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO roles (key, plane, description)
  VALUES ('SuperAdmin', 'nexus', 'Platform super administrator (full access via admin.superuser)')
  ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'admin.superuser' FROM roles r WHERE r.key = 'SuperAdmin'
  ON CONFLICT DO NOTHING;

-- Bootstrap platform admins. Emails stored lowercase to match SSO (tokens are lowercased).
WITH admins(email, name) AS (
  VALUES
    ('kevin.white@sbsfederal.com', 'Kevin White'),
    ('ethan.shepherd@sbsfederal.com', 'Ethan Shepherd'),
    ('andrew.dean@sbsfederal.com', 'Andrew Dean')
),
upserted AS (
  INSERT INTO users (plane, organization_id, email, display_name)
  SELECT 'nexus', NULL, email, name FROM admins
  ON CONFLICT (plane, email) DO UPDATE SET display_name = EXCLUDED.display_name
  RETURNING id
)
INSERT INTO role_assignments (user_id, role_id, organization_id)
  SELECT u.id, (SELECT id FROM roles WHERE key = 'SuperAdmin'), NULL
  FROM upserted u
  ON CONFLICT (user_id, role_id, organization_id) DO NOTHING;

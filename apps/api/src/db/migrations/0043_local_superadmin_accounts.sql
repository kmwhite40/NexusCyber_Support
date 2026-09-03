-- Three dedicated LOCAL break-glass SuperAdmin accounts (email + password sign-in),
-- separate from any SSO identity. They are nexus-plane platform SuperAdmins (admin.superuser,
-- org-NULL = platform-wide). Use them to sign in via the local login form where Entra SSO /
-- dev-login is unavailable (prod disables dev-login).
--
-- Password hashes are scrypt$salt$hash, matching auth/password.ts. These are BOOTSTRAP
-- credentials — rotate / rename them from the Platform Users page after first sign-in.
-- Idempotent.

INSERT INTO users (plane, organization_id, email, display_name, password_hash) VALUES
  ('nexus', NULL, 'admin1@anchor.local', 'Local Admin 1',
    'scrypt$237980ea6ccb703b58a82895a14a06d6$c084250351649408bd33e0a27ee0d9f9a19814e6c8b566cdf3346499730e98176cf4381412ec262982e9ffb24ec65c18d3ee1f8dd02a9b458d2296fc568e9900'),
  ('nexus', NULL, 'admin2@anchor.local', 'Local Admin 2',
    'scrypt$417730058d5b7ddf9f9fb2b015b58bca$477e403072cf0b2ed870b1597888789e5e20d60f343ca97face36c173b391afe7adf15147e2715de24d345445d9756d3e0e11cbcff90ad720077028f6af5c502'),
  ('nexus', NULL, 'admin3@anchor.local', 'Local Admin 3',
    'scrypt$23b0a074d647a45a1f1ebf72a1b56315$e2ea95e035ba3a1e33586da87224a31ee71d7c12876be75a2ec6ce865c84ca5bdcbd6a74d4e82e164d494db065ba2dc34179abb55d9ba8fc86fc1f5f13adc38e')
ON CONFLICT (plane, email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  display_name  = EXCLUDED.display_name;

-- Grant each the SuperAdmin role (org-NULL = platform-wide).
INSERT INTO role_assignments (user_id, role_id, organization_id)
  SELECT u.id, (SELECT id FROM roles WHERE key = 'SuperAdmin'), NULL
    FROM users u
   WHERE u.plane = 'nexus'
     AND u.email IN ('admin1@anchor.local', 'admin2@anchor.local', 'admin3@anchor.local')
  ON CONFLICT (user_id, role_id, organization_id) DO NOTHING;

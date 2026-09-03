-- Creates integration.credentials.manage in environments that are never seeded.
--
-- The permission was added to seed.ts alongside the device-sync feature, which is correct for a
-- fresh install and useless for production: seed does not run there, and must not — it rebuilds
-- role_permissions wholesale and can inject demo identities. Without this migration the feature
-- would deploy to production and 403 for everyone, with the cause invisible from the UI: the
-- page, the routes and the permission check would all be present and correct, and the permission
-- simply would not exist.
--
-- Idempotent, and safe to run against a database where seed already created the rows.

INSERT INTO permissions (key, domain) VALUES ('integration.credentials.manage', 'integration')
  ON CONFLICT (key) DO NOTHING;

-- ServiceDeskManager only, matching seed.ts.
--
-- Deliberately NOT granted to the customer-plane OrgAdmin that holds the neighbouring
-- integration.manage: configuring the credentials Nexus uses to read a customer's own directory
-- is a platform action, not something a customer administers for themselves. Anyone else who
-- needs it can be granted it explicitly.
INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'integration.credentials.manage'
    FROM roles r
   WHERE r.key = 'ServiceDeskManager'
ON CONFLICT DO NOTHING;

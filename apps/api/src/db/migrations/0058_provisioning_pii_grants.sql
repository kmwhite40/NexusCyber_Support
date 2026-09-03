-- Explicit GRANTs for tables created after 0001_init.sql's ALTER DEFAULT PRIVILEGES.
--
-- 0053 (ticket_sensitive_fields), 0056 (provisioning_runs, provisioning_steps) rely on
-- default privileges granting nexus_app (the RLS-enforced runtime role, see pool.ts)
-- SELECT/INSERT/UPDATE/DELETE automatically. That only holds if the role that ran
-- ALTER DEFAULT PRIVILEGES in 0001 is the same role that creates these tables at
-- migration time in every environment -- true in dev, unverified in prod. Grant
-- explicitly so the app role's access does not depend on that inference.
--
-- No sequence grants: all three tables use gen_random_uuid() PK defaults, not serial/
-- identity columns, so there is no owned sequence to grant USAGE/SELECT on.
--
-- Guarded like 0001: nexus_app is created conditionally there, so a fresh/unusual
-- environment where migrations run before that role exists must not fail here.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nexus_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_sensitive_fields TO nexus_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON provisioning_runs TO nexus_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON provisioning_steps TO nexus_app;
  END IF;
END $$;

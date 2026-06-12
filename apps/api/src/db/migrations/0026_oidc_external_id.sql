-- Entra ID (OIDC) agent login: stable external identity link.
-- Maps an Entra user (oid claim) to a nexus user row so the OIDC callback can
-- find/JIT-provision the agent. Nullable: local-password and seeded users have none.
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_key
  ON users (external_id) WHERE external_id IS NOT NULL;

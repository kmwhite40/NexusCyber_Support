-- Phase 2 customer SSO: map an external customer Entra tenant (tid) to an Anchor org.
-- The OIDC callback resolves the token's tid to this org and rejects unknown tenants
-- (the allow-list). Nullable: orgs without federated SSO have none.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS entra_tenant_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_entra_tenant_id_key
  ON organizations (entra_tenant_id) WHERE entra_tenant_id IS NOT NULL;

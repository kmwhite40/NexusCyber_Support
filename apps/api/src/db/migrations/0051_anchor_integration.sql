-- Anchor two-way integration: machine-to-machine API keys, an idempotency anchor on
-- tickets (external_ref), and an outbound webhook dispatcher for status writeback.
-- See docs/nexus/09 §U (eventing) and ADR-005. All new tables are org-scoped under the
-- same RLS isolation predicate as the rest of the platform.

-- ---------------- Per-organization API keys (M2M auth) ----------------
-- A key authenticates a non-interactive integration as a NEXUS-plane service identity
-- scoped to exactly ONE organization (assigned_orgs = [organization_id]). The secret is
-- never stored — only a scrypt hash (same format as local passwords). key_id is the
-- public lookup handle embedded in the presented token `ak_<key_id>_<secret>`.
CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_id          text NOT NULL UNIQUE,
  key_hash        text NOT NULL,
  name            text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',   -- bounded subset of permission verbs
  created_by      uuid,
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_api_keys_org ON api_keys(organization_id);

-- ---------------- Ticket idempotency anchor ----------------
-- external_ref carries the integration's stable item key (e.g. <tenantId>:<source>:<itemId>).
-- A repeated sync of the same source item upserts the existing ticket rather than creating
-- a duplicate. Unique per org, only when present (portal/agent tickets leave it NULL).
ALTER TABLE tickets ADD COLUMN external_ref    text;
ALTER TABLE tickets ADD COLUMN external_source text;
CREATE UNIQUE INDEX ux_tickets_org_external_ref
  ON tickets(organization_id, external_ref) WHERE external_ref IS NOT NULL;

-- ---------------- Outbound webhook endpoints ----------------
-- Per-org registered receivers for ticket.* domain events. secret is the HMAC-SHA256
-- signing key (write-only; returned once on creation). event_types empty = all ticket events.
CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url             text NOT NULL,
  secret          text NOT NULL,
  event_types     text[] NOT NULL DEFAULT '{}',
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_webhook_endpoints_org ON webhook_endpoints(organization_id) WHERE active;
CREATE TRIGGER trg_webhook_endpoints_updated BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------- Webhook delivery audit ----------------
CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        text NOT NULL,
  event_type      text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
  attempts        int  NOT NULL DEFAULT 0,
  response_status int,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX ix_webhook_deliveries_org_time ON webhook_deliveries(organization_id, created_at DESC);
CREATE INDEX ix_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

-- ---------------- Row-Level Security ----------------
-- Same org-isolation predicate as every other tenant table. The M2M auth lookup runs in
-- the owner/system context (bypasses RLS) like login does; management endpoints run in the
-- caller's org context, so a tenant only ever sees its own keys/endpoints/deliveries.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys','webhook_endpoints','webhook_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

-- ---------------- Permission: integration.manage ----------------
-- Gate for managing API keys and webhook endpoints. Granted to the platform service-desk
-- manager (nexus) and the customer org admin. admin.superuser already implies all verbs.
-- (Mirrors src/db/seed.ts so production — which applies migrations, not seed — stays in sync.)
INSERT INTO permissions (key, domain) VALUES ('integration.manage', 'integration')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
  SELECT id, 'integration.manage' FROM roles WHERE key IN ('ServiceDeskManager', 'OrgAdmin')
  ON CONFLICT DO NOTHING;

-- Nexus reference implementation schema (focused on the implemented vertical slice).
-- Mirrors docs/nexus/artifacts/db/schema.sql conventions: org_id discriminator + RLS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_nexus_in_scope(target_org uuid) RETURNS boolean AS $$
  SELECT current_setting('app.plane', true) = 'nexus'
     AND target_org = ANY (
       string_to_array(NULLIF(current_setting('app.assigned_orgs', true), ''), ',')::uuid[]
     );
$$ LANGUAGE sql STABLE;

-- ---------------- Tenancy ----------------
CREATE TABLE organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  cloud          text NOT NULL DEFAULT 'commercial' CHECK (cloud IN ('commercial','gcc','gcchigh','azgov')),
  enclave_id     text NOT NULL DEFAULT 'commercial',
  status         text NOT NULL DEFAULT 'active',
  data_boundary  text NOT NULL DEFAULT 'us-east',
  cmk_enabled    boolean NOT NULL DEFAULT false,
  dedicated_db   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_domains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          citext NOT NULL UNIQUE,
  verified_at     timestamptz,
  verification_method text
);

-- ---------------- Identity & access ----------------
CREATE TABLE identity_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type            text NOT NULL,
  issuer          text,
  authority       text,
  enabled         boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plane           text NOT NULL CHECK (plane IN ('nexus','customer')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  display_name    text,
  status          text NOT NULL DEFAULT 'active',
  -- Local-account credential (controlled fallback, docs/nexus/02 §E.3). scrypt hash.
  -- Null for SSO-only users. In production, prefer IdP federation over local accounts.
  password_hash   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plane, email)
);
CREATE INDEX ix_users_org ON users(organization_id);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  plane       text NOT NULL CHECK (plane IN ('nexus','customer')),
  description text
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  domain      text NOT NULL,
  description text
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE role_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles(id),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  jit             boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, organization_id)
);
CREATE INDEX ix_role_assign_user ON role_assignments(user_id);

CREATE TABLE assignment_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL DEFAULT 'nexus' CHECK (scope IN ('nexus','org')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL
);

-- ---------------- Services & CMDB ----------------
CREATE TABLE services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'technical'
);

CREATE TABLE configuration_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ci_class        text NOT NULL,
  name            text NOT NULL,
  criticality     smallint,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ci_org ON configuration_items(organization_id);

-- ---------------- SLA ----------------
CREATE TABLE business_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  tz              text NOT NULL DEFAULT 'America/New_York',
  coverage        text NOT NULL DEFAULT '8x5'
);

CREATE TABLE sla_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  applies_to      jsonb NOT NULL DEFAULT '{}',
  precedence      int NOT NULL DEFAULT 100,
  calendar_id     uuid REFERENCES business_calendars(id),
  active          boolean NOT NULL DEFAULT true
);

CREATE TABLE sla_targets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id   uuid NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
  metric      text NOT NULL CHECK (metric IN ('response','resolution','update','remediation')),
  priority    text,
  duration_minutes int NOT NULL,
  warn_at_pct numeric(4,3) NOT NULL DEFAULT 0.75
);

-- ---------------- Ticketing ----------------
CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_number   text NOT NULL,
  type            text NOT NULL DEFAULT 'incident',
  requester_id    uuid REFERENCES users(id),
  affected_user_id uuid REFERENCES users(id),
  source_channel  text NOT NULL DEFAULT 'portal',
  subject         text NOT NULL,
  description     text,
  category        text,
  service_id      uuid REFERENCES services(id),
  ci_id           uuid REFERENCES configuration_items(id),
  impact          smallint DEFAULT 3,
  urgency         smallint DEFAULT 3,
  priority        text DEFAULT 'P3',
  severity        text,
  status          text NOT NULL DEFAULT 'new',
  assignment_group_id uuid REFERENCES assignment_groups(id),
  assigned_agent_id   uuid REFERENCES users(id),
  sla_policy_id   uuid REFERENCES sla_policies(id),
  response_due_at timestamptz,
  resolution_due_at timestamptz,
  last_customer_update_at timestamptz,
  last_internal_update_at timestamptz,
  tags            text[] NOT NULL DEFAULT '{}',
  custom_fields   jsonb NOT NULL DEFAULT '{}',
  linked_posture_finding_id uuid,
  resolution_code text,
  closure_notes   text,
  satisfaction_score smallint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  closed_at       timestamptz,
  UNIQUE (organization_id, ticket_number)
);
CREATE INDEX ix_tickets_org_status ON tickets(organization_id, status);
CREATE INDEX ix_tickets_requester ON tickets(requester_id);
CREATE TRIGGER trg_tickets_updated BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES users(id),
  visibility      text NOT NULL DEFAULT 'customer' CHECK (visibility IN ('customer','internal')),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_comments_ticket ON ticket_comments(ticket_id);

CREATE TABLE ticket_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id        uuid,
  event_type      text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ticket_events_ticket ON ticket_events(ticket_id, created_at DESC);

CREATE TABLE sla_instances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  target_id       uuid REFERENCES sla_targets(id),
  metric          text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz NOT NULL,
  paused_minutes  int NOT NULL DEFAULT 0,
  state           text NOT NULL DEFAULT 'running'
                    CHECK (state IN ('running','paused','warning','met','breached')),
  breached_at     timestamptz
);
CREATE INDEX ix_sla_inst_ticket ON sla_instances(ticket_id);

-- ---------------- Posture ----------------
CREATE TABLE posture_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type      text NOT NULL DEFAULT 'org',
  overall_score   numeric(5,2),
  review_cadence_days int DEFAULT 90,
  last_reviewed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posture_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id      uuid REFERENCES posture_profiles(id),
  title           text NOT NULL,
  domain          text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('critical','high','moderate','low','info')),
  risk_score      numeric(5,2),
  status          text NOT NULL DEFAULT 'detected',
  remediation_due_at timestamptz,
  linked_ticket_id uuid REFERENCES tickets(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_finding_org_status ON posture_findings(organization_id, status);

-- ---------------- Notifications ----------------
CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  event_type      text NOT NULL,
  channel         text NOT NULL,
  recipient       text,
  status          text NOT NULL DEFAULT 'queued',
  substitution_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------- Audit ----------------
CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  actor_id        uuid,
  actor_plane     text,
  action          text NOT NULL,
  resource_type   text,
  resource_id     uuid,
  scope           text,
  detail          jsonb,
  prev_hash       text,
  row_hash        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_org_time ON audit_logs(organization_id, created_at DESC);
CREATE INDEX ix_audit_action ON audit_logs(action, created_at DESC);

-- ---------------- Platform ----------------
CREATE TABLE feature_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  cloud           text,
  key             text NOT NULL,
  value           jsonb NOT NULL DEFAULT 'false',
  UNIQUE (organization_id, cloud, key)
);

CREATE TABLE cloud_environments (
  cloud           text PRIMARY KEY,
  login_authority text NOT NULL,
  graph_endpoint  text NOT NULL,
  capability_matrix jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cloud_environments (cloud, login_authority, graph_endpoint, capability_matrix) VALUES
  ('commercial','https://login.microsoftonline.com','https://graph.microsoft.com',
     '{"teams":"supported","email":"supported","ai":"supported"}'),
  ('gcc','https://login.microsoftonline.com','https://graph.microsoft.com',
     '{"teams":"requires_validation","email":"requires_validation","ai":"requires_validation"}'),
  ('gcchigh','https://login.microsoftonline.us','https://graph.microsoft.us',
     '{"teams":"requires_validation","email":"requires_validation","ai":"disabled"}'),
  ('azgov','https://login.microsoftonline.us','https://graph.microsoft.us',
     '{"teams":"requires_validation","email":"requires_validation","ai":"disabled"}')
ON CONFLICT (cloud) DO NOTHING;

-- ---------------- Row-Level Security ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_domains','identity_providers','users','role_assignments','assignment_groups',
    'services','configuration_items','business_calendars','sla_policies',
    'tickets','ticket_comments','ticket_events','sla_instances',
    'posture_profiles','posture_findings','notification_deliveries','feature_flags'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

-- organizations is keyed on id (not organization_id) — its own policy.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_isolation ON organizations
  USING (id = app_org_id() OR app_is_nexus_in_scope(id))
  WITH CHECK (id = app_org_id() OR app_is_nexus_in_scope(id));

-- ---------------- Application runtime role ----------------
-- The API connects as nexus_app (NON-owner, NON-superuser) so RLS is ENFORCED on it.
-- migrate/seed connect as the owner role, which bypasses RLS for bootstrapping.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nexus_app') THEN
    CREATE ROLE nexus_app LOGIN PASSWORD 'nexus_app';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexus_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexus_app;

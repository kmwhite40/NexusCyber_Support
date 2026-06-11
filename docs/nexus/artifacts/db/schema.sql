-- =====================================================================
-- Nexus Platform — Core Database Schema (PostgreSQL)
-- Reference implementation of docs/nexus/09-data-api-events.md (Section S)
--
-- Conventions:
--   * uuid PKs (gen_random_uuid via pgcrypto)
--   * organization_id on every tenant-scoped table (RLS discriminator)
--   * created_at/updated_at timestamptz; soft delete via deleted_at
--   * Row-Level Security on tenant-scoped tables (belt) + app org-guard (suspenders)
--   * High-volume append tables partitioned by month (illustrated for audit/events)
--
-- Session GUCs set per request by the API after token validation:
--   app.org_id         -> the resolved organization (customer plane)
--   app.plane          -> 'nexus' | 'customer'
--   app.assigned_orgs  -> comma-separated org uuids (nexus plane scope)
--   app.elevated       -> 'true' when JIT elevation is active
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- Reusable updated_at trigger -----------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- Reusable RLS helper: current org context ----------------------------
CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_nexus_in_scope(target_org uuid) RETURNS boolean AS $$
  SELECT current_setting('app.plane', true) = 'nexus'
     AND target_org = ANY (
       string_to_array(NULLIF(current_setting('app.assigned_orgs', true), ''), ',')::uuid[]
     );
$$ LANGUAGE sql STABLE;

-- Standard tenant RLS macro (applied to each tenant table below):
--   USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))

-- =====================================================================
-- 1. TENANCY
-- =====================================================================
CREATE TABLE organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  cloud          text NOT NULL CHECK (cloud IN ('commercial','gcc','gcchigh','azgov')),
  enclave_id     text NOT NULL,
  status         text NOT NULL DEFAULT 'onboarding'
                   CHECK (status IN ('prospect','onboarding','active','suspended','offboarding','deleted')),
  data_boundary  text NOT NULL,
  primary_idp_id uuid,
  cmk_enabled    boolean NOT NULL DEFAULT false,
  dedicated_db   boolean NOT NULL DEFAULT false,
  legal_hold     boolean NOT NULL DEFAULT false,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE TRIGGER trg_org_updated BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_domains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          citext NOT NULL UNIQUE,
  verified_at     timestamptz,
  verification_method text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_org_domains_org ON organization_domains(organization_id);

CREATE TABLE organization_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  branding        jsonb NOT NULL DEFAULT '{}',
  notification_rules jsonb NOT NULL DEFAULT '{}',
  feature_overrides  jsonb NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_no     text NOT NULL,
  starts_on       date NOT NULL,
  ends_on         date,
  coverage        text NOT NULL DEFAULT '8x5' CHECK (coverage IN ('8x5','24x7')),
  severity_coverage jsonb NOT NULL DEFAULT '{}',
  entitlements    jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_contracts_org ON organization_contracts(organization_id);

CREATE TABLE assignment_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL CHECK (scope IN ('nexus','org')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_groups_org ON assignment_groups(organization_id);

-- =====================================================================
-- 2. IDENTITY & ACCESS
-- =====================================================================
CREATE TABLE identity_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = Nexus IdP
  type            text NOT NULL CHECK (type IN ('entra_oidc','saml','oidc','b2b','external_id','magic_link','local')),
  issuer          text,
  authority       text,
  client_id       text,
  jwks_uri        text,
  claim_mappings  jsonb NOT NULL DEFAULT '{}',
  domain_restrictions text[],
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_idp_org ON identity_providers(organization_id);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plane           text NOT NULL CHECK (plane IN ('nexus','customer')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,   -- null for nexus plane
  email           citext NOT NULL,
  display_name    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','invited')),
  attributes      jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (plane, email)
);
CREATE INDEX ix_users_org ON users(organization_id);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idp_id      uuid NOT NULL REFERENCES identity_providers(id),
  issuer      text NOT NULL,
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX ix_user_identities_user ON user_identities(user_id);

CREATE TABLE groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,           -- e.g. 'Tier1','OrgAdmin'
  plane       text NOT NULL CHECK (plane IN ('nexus','customer')),
  description text
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,               -- e.g. 'ticket.read.organization'
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
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- scope; null = all-assigned (nexus)
  assigned_by     uuid REFERENCES users(id),
  jit             boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, organization_id)
);
CREATE INDEX ix_role_assign_user ON role_assignments(user_id);
CREATE INDEX ix_role_assign_org ON role_assignments(organization_id);

-- =====================================================================
-- 3. SERVICES & CMDB
-- =====================================================================
CREATE TABLE services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global service
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'technical' CHECK (kind IN ('business','technical')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE configuration_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ci_class        text NOT NULL,
  name            text NOT NULL,
  external_ref    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  criticality     smallint CHECK (criticality BETWEEN 1 AND 4),
  environment     text,
  owner_id        uuid REFERENCES users(id),
  support_group_id uuid REFERENCES assignment_groups(id),
  attributes      jsonb NOT NULL DEFAULT '{}',
  discovered_source text,
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ci_org_class ON configuration_items(organization_id, ci_class);
CREATE INDEX ix_ci_external ON configuration_items(external_ref);
CREATE TRIGGER trg_ci_updated BEFORE UPDATE ON configuration_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ci_relationships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_ci   uuid NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  target_ci   uuid NOT NULL REFERENCES configuration_items(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN
                ('depends_on','runs_on','hosts','connects_to','member_of','uses_license','owned_by_vendor','located_at')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_ci, target_ci, type)
);
CREATE INDEX ix_cirel_source ON ci_relationships(source_ci);

-- =====================================================================
-- 4. TICKETING
-- =====================================================================
CREATE TABLE sla_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  contract_id     uuid REFERENCES organization_contracts(id),
  service_id      uuid REFERENCES services(id),
  applies_to      jsonb NOT NULL DEFAULT '{}',     -- {type, severity}
  precedence      int NOT NULL DEFAULT 100,
  calendar_id     uuid,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  tz              text NOT NULL DEFAULT 'America/New_York',
  weekly_hours    jsonb NOT NULL,                  -- per-weekday windows
  holidays        jsonb NOT NULL DEFAULT '[]',
  maintenance_windows jsonb NOT NULL DEFAULT '[]',
  coverage        text NOT NULL DEFAULT '8x5' CHECK (coverage IN ('8x5','24x7')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sla_policies
  ADD CONSTRAINT fk_sla_calendar FOREIGN KEY (calendar_id) REFERENCES business_calendars(id);

CREATE TABLE sla_targets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id   uuid NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
  metric      text NOT NULL CHECK (metric IN ('response','resolution','update','remediation')),
  severity    text,
  priority    text,
  duration    interval NOT NULL,
  pause_states text[] NOT NULL DEFAULT '{}',
  warn_at_pct numeric(4,3) NOT NULL DEFAULT 0.75
);

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_number   text NOT NULL,
  type            text NOT NULL CHECK (type IN
                    ('incident','service_request','access_request','change_request','problem',
                     'major_incident','security_event','posture_finding','monitoring_alert',
                     'customer_question','billing_support')),
  requester_id    uuid REFERENCES users(id),
  affected_user_id uuid REFERENCES users(id),
  contact_method  text,
  source_channel  text NOT NULL,
  subject         text NOT NULL,
  description     text,
  category        text,
  subcategory     text,
  service_id      uuid REFERENCES services(id),
  ci_id           uuid REFERENCES configuration_items(id),
  impact          smallint CHECK (impact BETWEEN 1 AND 4),
  urgency         smallint CHECK (urgency BETWEEN 1 AND 4),
  priority        text CHECK (priority IN ('P1','P2','P3','P4')),
  severity        text CHECK (severity IN ('Sev1','Sev2','Sev3','Sev4')),
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
  parent_ticket_id uuid REFERENCES tickets(id),
  linked_posture_finding_id uuid,
  linked_change_id uuid,
  linked_problem_id uuid,
  resolution_code text,
  closure_notes   text,
  satisfaction_score smallint,
  merged_into     uuid REFERENCES tickets(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  closed_at       timestamptz,
  UNIQUE (organization_id, ticket_number)
);
CREATE INDEX ix_tickets_org_status ON tickets(organization_id, status);
CREATE INDEX ix_tickets_assignee ON tickets(assigned_agent_id) WHERE status <> 'closed';
CREATE INDEX ix_tickets_due ON tickets(resolution_due_at) WHERE status NOT IN ('resolved','closed');
CREATE INDEX ix_tickets_requester ON tickets(requester_id);
CREATE TRIGGER trg_tickets_updated BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_comments_ticket ON ticket_comments(ticket_id);

CREATE TABLE ticket_internal_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notes_ticket ON ticket_internal_notes(ticket_id);

CREATE TABLE ticket_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  content_type text,
  size_bytes  bigint,
  blob_ref    text NOT NULL,                 -- {enclave}/{org}/...
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','error')),
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_attach_ticket ON ticket_attachments(ticket_id);

CREATE TABLE ticket_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  linked_ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('duplicate_of','caused_by','related_to','blocks','child_of')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, linked_ticket_id, type)
);

CREATE TABLE ticket_watchers (
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, user_id)
);

-- Append-only ticket event stream (partitioned by month)
CREATE TABLE ticket_events (
  id          uuid DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  ticket_id   uuid NOT NULL,
  actor_id    uuid,
  event_type  text NOT NULL,                 -- status_changed, assigned, commented, sla_warning...
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ix_ticket_events_ticket ON ticket_events(ticket_id, created_at DESC);
-- Example partition (create per month via job):
CREATE TABLE ticket_events_2026_06 PARTITION OF ticket_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- SLA running timers
CREATE TABLE sla_instances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  target_id   uuid NOT NULL REFERENCES sla_targets(id),
  metric      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL,
  paused_total interval NOT NULL DEFAULT '0',
  state       text NOT NULL DEFAULT 'running' CHECK (state IN ('running','paused','warning','met','breached')),
  breached_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sla_inst_ticket ON sla_instances(ticket_id);
CREATE INDEX ix_sla_inst_open ON sla_instances(due_at) WHERE state IN ('running','warning','paused');

-- =====================================================================
-- 5. ESCALATION & ON-CALL
-- =====================================================================
CREATE TABLE escalation_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  applies_to  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE escalation_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id   uuid NOT NULL REFERENCES escalation_policies(id) ON DELETE CASCADE,
  step_order  int NOT NULL,
  trigger     text NOT NULL CHECK (trigger IN ('no_ack','sla_warning','sla_breach','manual','time_in_state')),
  delay       interval NOT NULL DEFAULT '0',
  targets     jsonb NOT NULL,                 -- [{group|role|user|oncall}]
  channels    text[] NOT NULL DEFAULT '{}',
  repeat      int NOT NULL DEFAULT 0,
  stop_on_ack boolean NOT NULL DEFAULT true,
  UNIQUE (policy_id, step_order)
);

CREATE TABLE oncall_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = nexus-wide
  team        text NOT NULL,
  tz          text NOT NULL DEFAULT 'America/New_York',
  coverage    text NOT NULL DEFAULT '24x7',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oncall_rotations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('primary','secondary','tertiary','backup','ic')),
  length      interval NOT NULL DEFAULT '7 days',
  handoff_time time NOT NULL DEFAULT '09:00',
  restrictions jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE oncall_participants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rotation_id uuid NOT NULL REFERENCES oncall_rotations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  position    int NOT NULL,
  contact_methods text[] NOT NULL DEFAULT '{}',
  quiet_hours jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE oncall_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  replaces_user_id uuid REFERENCES users(id),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text,
  approved_by uuid REFERENCES users(id)
);
CREATE TABLE oncall_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  ticket_id   uuid REFERENCES tickets(id),
  schedule_id uuid REFERENCES oncall_schedules(id),
  severity    text NOT NULL,
  state       text NOT NULL DEFAULT 'created' CHECK (state IN ('created','notified','acknowledged','escalated','resolved')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oncall_acknowledgements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES oncall_pages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  acked_at    timestamptz NOT NULL DEFAULT now(),
  via         text
);

-- =====================================================================
-- 6. POSTURE
-- =====================================================================
CREATE TABLE posture_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type    text NOT NULL CHECK (scope_type IN ('org','m365_tenant','azure_sub','domain')),
  scope_ref     text,
  overall_score numeric(5,2),
  review_cadence interval,
  owner_id      uuid REFERENCES users(id),
  last_reviewed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_posture_profile_org ON posture_profiles(organization_id);

CREATE TABLE posture_snapshots (
  id          uuid DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  profile_id  uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,
  metrics     jsonb NOT NULL,
  score       numeric(5,2),
  hash        text NOT NULL,
  PRIMARY KEY (id, captured_at)
) PARTITION BY RANGE (captured_at);
CREATE INDEX ix_snapshot_profile_time ON posture_snapshots(profile_id, captured_at DESC);
CREATE TABLE posture_snapshots_2026_06 PARTITION OF posture_snapshots
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE posture_findings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES posture_profiles(id),
  title         text NOT NULL,
  domain        text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('critical','high','moderate','low','info')),
  risk_score    numeric(5,2),
  status        text NOT NULL DEFAULT 'detected',
  control_refs  text[],
  ci_refs       uuid[],
  discovered_at timestamptz NOT NULL DEFAULT now(),
  remediation_due_at timestamptz,
  owner_id      uuid REFERENCES users(id),
  linked_ticket_id uuid REFERENCES tickets(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_finding_org_status ON posture_findings(organization_id, status);
CREATE INDEX ix_finding_due ON posture_findings(remediation_due_at)
  WHERE status NOT IN ('remediated','closed','accepted');
CREATE TRIGGER trg_finding_updated BEFORE UPDATE ON posture_findings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE posture_controls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  framework     text NOT NULL,
  control_id    text NOT NULL,
  implementation_status text NOT NULL DEFAULT 'not_assessed',
  assessed_at   timestamptz,
  assessor_id   uuid REFERENCES users(id),
  notes         text,
  UNIQUE (organization_id, framework, control_id)
);

CREATE TABLE posture_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CHECK (subject_type IN ('finding','control','snapshot')),
  subject_id    uuid NOT NULL,
  type          text NOT NULL,
  blob_ref      text NOT NULL,
  collected_at  timestamptz NOT NULL DEFAULT now(),
  collected_by  uuid REFERENCES users(id),
  hash          text NOT NULL,
  immutable     boolean NOT NULL DEFAULT true
);
CREATE INDEX ix_evidence_subject ON posture_evidence(subject_type, subject_id);

CREATE TABLE posture_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id    uuid REFERENCES posture_findings(id),
  risk_id       uuid,
  justification text NOT NULL,
  requested_by  uuid REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),     -- enforced ≠ requested_by in app/PDP
  approved_at   timestamptz,
  expires_at    timestamptz,
  compensating_controls text,
  status        text NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','approved','active','expiring','expired','rejected')),
  CONSTRAINT chk_exc_sod CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE posture_risks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title         text NOT NULL,
  likelihood    smallint, impact smallint,
  inherent_score numeric(5,2), residual_score numeric(5,2),
  treatment     text CHECK (treatment IN ('accept','mitigate','transfer','avoid')),
  owner_id      uuid REFERENCES users(id),
  review_due    date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE poam_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id    uuid REFERENCES posture_findings(id),
  control_id    text,
  weakness      text NOT NULL,
  milestones    jsonb NOT NULL DEFAULT '[]',
  scheduled_completion date,
  status        text NOT NULL DEFAULT 'open',
  responsible_party text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE posture_exceptions
  ADD CONSTRAINT fk_exc_risk FOREIGN KEY (risk_id) REFERENCES posture_risks(id);

-- =====================================================================
-- 7. NOTIFICATIONS & INTEGRATIONS
-- =====================================================================
CREATE TABLE notification_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  event_type  text NOT NULL,
  channel     text NOT NULL,
  subject     text,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  event_type  text NOT NULL,
  recipient_id uuid REFERENCES users(id),
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id          uuid DEFAULT gen_random_uuid(),
  organization_id uuid,
  notification_id uuid,
  channel     text NOT NULL,
  status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','failed','dead_lettered','substituted')),
  attempts    int NOT NULL DEFAULT 0,
  provider_response jsonb,
  substitution_reason text,                    -- e.g. "Teams unavailable in gcchigh → email"
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE notification_deliveries_2026_06 PARTITION OF notification_deliveries
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE integrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL,                   -- graph_identity, defender, intune, mail, teams...
  cloud       text NOT NULL,
  app_object_id text,
  consent_status text NOT NULL DEFAULT 'pending',
  scopes      text[] NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_integrations_org ON integrations(organization_id);

CREATE TABLE integration_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  cred_type   text NOT NULL CHECK (cred_type IN ('certificate','managed_identity','secret','workload_federation')),
  key_vault_ref text,                          -- secret material NEVER stored here
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_health_checks (
  id          uuid DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  capability  text NOT NULL,
  status      text NOT NULL,
  detail      jsonb,
  PRIMARY KEY (id, checked_at)
) PARTITION BY RANGE (checked_at);
CREATE TABLE integration_health_checks_2026_06 PARTITION OF integration_health_checks
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE consent_records (   -- compliance evidence (AC/CM)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  integration_id uuid REFERENCES integrations(id),
  admin_upn   text NOT NULL,
  tenant_id   text NOT NULL,
  cloud       text NOT NULL,
  scopes      text[] NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  hash        text NOT NULL
);

-- =====================================================================
-- 8. KNOWLEDGE, APPROVALS, AUTOMATION, REPORTS, AI
-- =====================================================================
CREATE TABLE knowledge_articles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global/internal
  scope       text NOT NULL CHECK (scope IN ('internal','global_customer','customer_specific','runbook')),
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  owner_id    uuid REFERENCES users(id),
  tags        text[] NOT NULL DEFAULT '{}',
  review_due  date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_article_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  uuid NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  version     int NOT NULL,
  body        text NOT NULL,
  published   boolean NOT NULL DEFAULT false,
  author_id   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);

CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL,                  -- ticket | change | automation
  subject_id  uuid NOT NULL,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE approval_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_order  int NOT NULL,
  approver_id uuid REFERENCES users(id),
  decision    text CHECK (decision IN ('approved','rejected')),
  reason      text,
  decided_at  timestamptz
);

CREATE TABLE automation_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  name        text NOT NULL,
  definition  jsonb NOT NULL,                   -- trigger/when/actions
  version     int NOT NULL DEFAULT 1,
  state       text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','testing','published','disabled')),
  author_id   uuid REFERENCES users(id),
  publisher_id uuid REFERENCES users(id),       -- enforced ≠ author for sensitive tenants
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE automation_executions (
  id          uuid DEFAULT gen_random_uuid(),
  organization_id uuid,
  rule_id     uuid NOT NULL,
  rule_version int NOT NULL,
  trigger     jsonb,
  inputs_hash text,
  outcome     text NOT NULL,
  steps       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE automation_executions_2026_06 PARTITION OF automation_executions
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE report_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  cron        text NOT NULL,
  recipients  jsonb NOT NULL DEFAULT '[]',
  format      text NOT NULL DEFAULT 'pdf'
);

CREATE TABLE ai_interactions (
  id          uuid DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  feature     text NOT NULL,
  model       text NOT NULL,
  input_hash  text NOT NULL,
  output_hash text NOT NULL,
  approver_id uuid,
  customer_visible boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE ai_interactions_2026_06 PARTITION OF ai_interactions
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- =====================================================================
-- 9. PLATFORM: AUDIT, API CLIENTS, WEBHOOKS, FLAGS, CLOUD ENVS
-- =====================================================================
CREATE TABLE audit_logs (
  id          uuid DEFAULT gen_random_uuid(),
  organization_id uuid,
  actor_id    uuid,
  actor_plane text,
  action      text NOT NULL,
  resource_type text,
  resource_id uuid,
  scope       text,
  classification text,
  ip          inet,
  user_agent  text,
  detail      jsonb,
  prev_hash   text,
  row_hash    text NOT NULL,                   -- hash chain for tamper-evidence
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ix_audit_org_time ON audit_logs(organization_id, created_at DESC);
CREATE INDEX ix_audit_action ON audit_logs(action, created_at DESC);
CREATE TABLE audit_logs_2026_06 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE api_clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  auth_type   text NOT NULL CHECK (auth_type IN ('client_credentials','mtls')),
  key_vault_ref text,
  scopes      text[] NOT NULL DEFAULT '{}',
  rate_limit  int NOT NULL DEFAULT 600,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url         text NOT NULL,
  events      text[] NOT NULL DEFAULT '{}',
  secret_vault_ref text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = platform-wide
  cloud       text,                            -- null = all clouds
  key         text NOT NULL,                   -- e.g. ai.enabled, teams.notify
  value       jsonb NOT NULL DEFAULT 'false',
  UNIQUE (organization_id, cloud, key)
);

CREATE TABLE cloud_environments (
  cloud           text PRIMARY KEY,            -- commercial | gcc | gcchigh | azgov
  login_authority text NOT NULL,
  graph_endpoint  text NOT NULL,
  capability_matrix jsonb NOT NULL,            -- {teams, email, defender, intune, ai...}
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 10. ROW-LEVEL SECURITY (applied to tenant-scoped tables)
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_domains','organization_settings','organization_contracts','assignment_groups',
    'identity_providers','users','groups','role_assignments',
    'services','configuration_items','ci_relationships',
    'sla_policies','business_calendars','tickets','ticket_comments','ticket_internal_notes',
    'ticket_attachments','ticket_links','sla_instances',
    'escalation_policies','oncall_schedules','oncall_pages',
    'posture_profiles','posture_findings','posture_controls','posture_evidence',
    'posture_exceptions','posture_risks','poam_items',
    'notification_templates','notifications','integrations','consent_records',
    'knowledge_articles','approvals','automation_rules','reports','api_clients','webhooks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

-- NOTE: ticket_events, posture_snapshots, notification_deliveries, automation_executions,
-- audit_logs, ai_interactions, integration_health_checks carry organization_id and are
-- filtered at the application/query layer (partitioned append tables); enable RLS on their
-- partitions in the same pattern if direct SQL access is permitted.

-- =====================================================================
-- 11. SEED: cloud environments (gov rows REQUIRE VALIDATION before use)
-- =====================================================================
INSERT INTO cloud_environments (cloud, login_authority, graph_endpoint, capability_matrix) VALUES
  ('commercial','https://login.microsoftonline.com','https://graph.microsoft.com',
     '{"teams":"supported","email":"supported","defender":"supported","intune":"supported","ai":"supported"}'),
  ('gcc','https://login.microsoftonline.com','https://graph.microsoft.com',
     '{"teams":"requires_validation","email":"requires_validation","defender":"requires_validation","intune":"requires_validation","ai":"requires_validation"}'),
  ('gcchigh','https://login.microsoftonline.us','https://graph.microsoft.us',
     '{"teams":"requires_validation","email":"requires_validation","defender":"requires_validation","intune":"requires_validation","ai":"disabled"}'),
  ('azgov','https://login.microsoftonline.us','https://graph.microsoft.us',
     '{"teams":"requires_validation","email":"requires_validation","defender":"requires_validation","intune":"requires_validation","ai":"disabled"}')
ON CONFLICT (cloud) DO NOTHING;

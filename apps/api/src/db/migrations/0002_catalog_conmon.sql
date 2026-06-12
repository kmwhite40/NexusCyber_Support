-- Service catalog (request fulfillment workflows) + Continuous Monitoring (ConMon).
-- Implements docs/nexus/workflows/service-desk-workflows.md.

-- ---------------- Service catalog (global config) ----------------
CREATE TABLE service_catalog_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL UNIQUE,
  name              text NOT NULL,
  category          text NOT NULL,
  description       text,
  ticket_type       text NOT NULL DEFAULT 'service_request',
  owning_tier       text NOT NULL,           -- assignment group name to route to
  escalates_to      text,
  requires_approval boolean NOT NULL DEFAULT false,
  approver_hint     text,                    -- who approves (display)
  default_priority  text NOT NULL DEFAULT 'P3',
  security_class    text NOT NULL DEFAULT 'standard', -- standard | privileged | security
  sla_response_min  int NOT NULL DEFAULT 60,
  sla_resolution_min int NOT NULL DEFAULT 480,
  fulfillment_steps jsonb NOT NULL DEFAULT '[]', -- [{key,label,role,automatable}]
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------- Per-ticket fulfillment tasks (tenant) ----------------
CREATE TABLE service_request_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  step_key        text NOT NULL,
  label           text NOT NULL,
  assignee_role   text,
  position        int NOT NULL DEFAULT 0,
  automatable     boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  completed_by    uuid REFERENCES users(id),
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tasks_ticket ON service_request_tasks(ticket_id, position);

-- ---------------- ConMon checks (global config) ----------------
CREATE TABLE conmon_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,
  name          text NOT NULL,
  domain        text NOT NULL,
  cadence_days  int NOT NULL DEFAULT 7,
  control_refs  text[] NOT NULL DEFAULT '{}',
  severity      text NOT NULL DEFAULT 'moderate',
  active        boolean NOT NULL DEFAULT true
);

-- ---------------- ConMon run history (tenant) ----------------
CREATE TABLE conmon_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  check_key       text NOT NULL,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  result          text NOT NULL CHECK (result IN ('pass','finding','error')),
  finding_id      uuid REFERENCES posture_findings(id),
  detail          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_conmon_runs_org_time ON conmon_runs(organization_id, ran_at DESC);

-- ---------------- RLS on tenant tables ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_request_tasks','conmon_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

-- Default privileges from migration 0001 already grant nexus_app DML on these new tables.

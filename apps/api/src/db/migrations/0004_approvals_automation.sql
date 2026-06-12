-- Approvals (referenced by the service catalog & ticket approval gate) + the
-- automation / workflow engine (docs/nexus/07-automation-kb-reporting.md §M).

-- ---------------- Approvals (tenant, RLS) ----------------
CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type    text NOT NULL,           -- ticket | change | automation
  subject_id      uuid NOT NULL,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_approvals_subject ON approvals(subject_id);

CREATE TABLE approval_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  approval_id     uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_order      int NOT NULL,
  approver_id     uuid REFERENCES users(id),
  decision        text CHECK (decision IN ('approved','rejected')),
  reason          text,
  decided_at      timestamptz
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approvals','approval_steps']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

-- ---------------- Automation rules + executions (Nexus-internal, no RLS) ----------------
-- Rules may be global (organization_id NULL) or per-org. The engine reads published
-- rules server-side via the system context; the CRUD API enforces nexus + automation.*.
CREATE TABLE automation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  definition      jsonb NOT NULL,          -- {trigger, conditions, actions}
  version         int NOT NULL DEFAULT 1,
  state           text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','testing','published','disabled')),
  author_id       uuid REFERENCES users(id),
  publisher_id    uuid REFERENCES users(id),  -- enforced <> author for sensitive tenants
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_automation_state ON automation_rules(state);

CREATE TABLE automation_executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  rule_id         uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  rule_version    int NOT NULL,
  trigger_event   text,
  outcome         text NOT NULL,           -- executed | skipped | failed | simulated
  steps           jsonb NOT NULL DEFAULT '[]',
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
CREATE INDEX ix_automation_exec_rule ON automation_executions(rule_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_rules, automation_executions TO nexus_app;

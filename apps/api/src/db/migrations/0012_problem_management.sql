-- Problem management (ITIL): a problem is the underlying cause of one or more incidents.
-- Tracks root cause, workaround, and known-error status; incidents link via tickets.problem_id.
CREATE TABLE problems (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','investigating','known_error','resolved','closed')),
  priority        text NOT NULL DEFAULT 'P3',
  root_cause      text,
  workaround      text,
  known_error     boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX ix_problems_status ON problems(status);

ALTER TABLE tickets ADD COLUMN problem_id uuid REFERENCES problems(id) ON DELETE SET NULL;
CREATE INDEX ix_tickets_problem ON tickets(problem_id);

ALTER TABLE problems ENABLE ROW LEVEL SECURITY;
CREATE POLICY problems_isolation ON problems
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON problems TO nexus_app;

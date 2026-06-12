-- CSAT satisfaction surveys. A survey is created when a ticket is resolved; the requester
-- responds with a 1-5 score, which is written back to tickets.satisfaction_score (consumed
-- by analytics). A token supports an emailed survey link in production.
CREATE TABLE csat_surveys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  token           text NOT NULL UNIQUE,
  score           int CHECK (score BETWEEN 1 AND 5),
  comment         text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  UNIQUE (ticket_id)
);
CREATE INDEX ix_csat_org ON csat_surveys(organization_id);

ALTER TABLE csat_surveys ENABLE ROW LEVEL SECURITY;
CREATE POLICY csat_isolation ON csat_surveys
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON csat_surveys TO nexus_app;

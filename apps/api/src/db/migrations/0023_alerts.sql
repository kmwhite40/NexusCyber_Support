-- Operations alerts (Opsgenie-style). triggered -> acknowledged -> resolved, dedup key,
-- and escalation into an on-call page and/or ticket.
CREATE TABLE alerts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source               text NOT NULL DEFAULT 'manual',
  dedup_key            text,
  severity             text NOT NULL DEFAULT 'P3' CHECK (severity IN ('P1','P2','P3','P4')),
  state                text NOT NULL DEFAULT 'triggered' CHECK (state IN ('triggered','acknowledged','resolved')),
  summary              text NOT NULL,
  details              jsonb NOT NULL DEFAULT '{}',
  acknowledged_by      uuid REFERENCES users(id),
  acknowledged_at      timestamptz,
  resolved_at          timestamptz,
  escalated_page_id    uuid REFERENCES oncall_pages(id),
  escalated_ticket_id  uuid REFERENCES tickets(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX alerts_open_dedup ON alerts (organization_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state <> 'resolved';

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_isolation ON alerts
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON alerts TO nexus_app;

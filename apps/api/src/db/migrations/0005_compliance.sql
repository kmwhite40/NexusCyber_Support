-- Compliance control catalog + control->evidence mappings (global config, org-NULL,
-- no RLS — read via the system context), plus posture exceptions (tenant, RLS).
-- Evidence itself is computed at read time from audit_logs / posture_findings /
-- conmon_runs; see docs/superpowers/plans/2026-06-11-nexus-tier1-security-compliance.md.

CREATE TABLE compliance_controls (
  control_id   text PRIMARY KEY,                 -- e.g. 'AC-2'
  framework    text NOT NULL,                    -- 'NIST-800-53' | 'NIST-800-171' | 'CMMC-L2'
  family       text NOT NULL,                    -- 'Access Control'
  title        text NOT NULL,
  description  text
);

-- Which runtime signal satisfies a control.
--   source = 'audit_action'   -> presence of audit_logs.action = source_key (recent)
--   source = 'posture_domain' -> no OPEN posture_findings in domain = source_key
--   source = 'conmon_check'   -> latest conmon_runs for check = source_key is 'pass'
CREATE TABLE control_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id  text NOT NULL REFERENCES compliance_controls(control_id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('audit_action','posture_domain','conmon_check')),
  source_key  text NOT NULL,
  UNIQUE (control_id, source, source_key)
);
CREATE INDEX ix_control_mappings_control ON control_mappings(control_id);

CREATE TABLE posture_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id           uuid NOT NULL REFERENCES posture_findings(id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES users(id),
  justification        text NOT NULL,
  compensating_control text,
  expires_at           timestamptz,
  status               text NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','approved','rejected','expired')),
  decided_by           uuid REFERENCES users(id),
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_posture_exceptions_finding ON posture_exceptions(finding_id);

ALTER TABLE posture_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY posture_exceptions_isolation ON posture_exceptions
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON posture_exceptions TO nexus_app;
GRANT SELECT ON compliance_controls, control_mappings TO nexus_app;

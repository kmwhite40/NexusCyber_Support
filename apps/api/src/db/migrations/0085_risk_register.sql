-- Enterprise risk register, one register per organization.
--
-- Modelled on the common core of NIST SP 800-30 / 800-39 (RMF), ISO 31000, FAIR and the
-- FedRAMP POA&M, and on what ServiceNow IRM, RSA Archer and LogicGate converge on:
--
--   * three-point scoring — INHERENT (no controls), RESIDUAL (current controls), TARGET (after the
--     treatment plan) — each a 5x5 likelihood x impact pair. Scores are stored as their inputs and
--     the derived score is a generated column, so a rating can never drift from what produced it.
--   * a per-organization appetite / tolerance (risk_org_settings) that residual risk is judged
--     against. Appetite belongs to the organization, not to the platform: one customer's
--     acceptable is another's reportable.
--   * an optional FAIR quantitative estimate (PERT ranges for loss-event frequency and loss
--     magnitude), simulated server-side into fair_results.
--   * treatment plans as POA&M-style milestones (risk_treatments).
--   * formal acceptance with separation of duties and an expiry (columns on risks).
--   * an append-only assessment history (risk_history) for trend lines and audit.
--   * links to the evidence that already lives in Nexus: controls, posture findings, tickets,
--     problems, changes and services (risk_links).
--
-- ISOLATION. Every table carries organization_id and the same RLS policy as problems/posture,
-- including the child tables: a child row is never visible "through" a parent another tenant owns.
--
-- Permissions risk.read / risk.manage / risk.accept are dual-written into seed.ts — seed DELETEs
-- and rebuilds role_permissions, so a grant that lived only here would be stripped by a re-seed;
-- and seed never runs in production, so a grant that lived only in seed would 403 there.
-- Idempotent inserts only.

CREATE TABLE risks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Human reference, per organization: R-0001 at every customer, never a global counter that
  -- would leak how many risks other tenants hold.
  risk_number        integer NOT NULL,
  title              text NOT NULL,
  description        text,
  -- Structured risk statement (ISO 31000 / bow-tie): because of <cause>, <event> may occur,
  -- leading to <consequence>. Optional, but the register reads far better with it.
  cause              text,
  event              text,
  consequence        text,
  category           text NOT NULL DEFAULT 'cybersecurity'
                       CHECK (category IN ('cybersecurity','privacy','operational','compliance','third_party',
                                           'technology','financial','strategic','reputational','physical')),
  threat_source      text CHECK (threat_source IN ('adversarial','accidental','structural','environmental')),
  status             text NOT NULL DEFAULT 'identified'
                       CHECK (status IN ('identified','assessed','treating','monitoring','accepted','closed')),
  strategy           text CHECK (strategy IN ('mitigate','transfer','avoid','accept')),
  owner_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  owner_name         text,             -- free-text owner for people not in Nexus (e.g. a CFO)

  inherent_likelihood smallint NOT NULL CHECK (inherent_likelihood BETWEEN 1 AND 5),
  inherent_impact     smallint NOT NULL CHECK (inherent_impact BETWEEN 1 AND 5),
  residual_likelihood smallint NOT NULL CHECK (residual_likelihood BETWEEN 1 AND 5),
  residual_impact     smallint NOT NULL CHECK (residual_impact BETWEEN 1 AND 5),
  target_likelihood   smallint CHECK (target_likelihood BETWEEN 1 AND 5),
  target_impact       smallint CHECK (target_impact BETWEEN 1 AND 5),
  inherent_score      smallint GENERATED ALWAYS AS (inherent_likelihood * inherent_impact) STORED,
  residual_score      smallint GENERATED ALWAYS AS (residual_likelihood * residual_impact) STORED,
  target_score        smallint GENERATED ALWAYS AS (target_likelihood * target_impact) STORED,

  -- Per-dimension impact (0-5): confidentiality, integrity, availability, financial, operational,
  -- reputational, compliance, safety. The overall impact is their high-water mark (FIPS 199).
  impact_dimensions  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- How quickly the risk would hit once triggered (COSO ERM "velocity").
  velocity           text CHECK (velocity IN ('slow','moderate','rapid','immediate')),

  fair_inputs        jsonb,            -- {lef:{min,likely,max}, lm:{min,likely,max}}
  fair_results       jsonb,            -- {mean,p10,p50,p90,p95,iterations,seed}

  review_frequency_days integer,       -- null => derived from the residual rating
  last_reviewed_at   timestamptz NOT NULL DEFAULT now(),
  next_review_at     timestamptz NOT NULL,

  -- Acceptance (separation of duties: the requester can never be the approver).
  acceptance_status        text NOT NULL DEFAULT 'none'
                             CHECK (acceptance_status IN ('none','requested','approved','rejected')),
  acceptance_justification text,
  acceptance_expires_at    timestamptz,
  acceptance_requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  acceptance_decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  acceptance_decided_at    timestamptz,

  tags               text[] NOT NULL DEFAULT '{}',
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  UNIQUE (organization_id, risk_number)
);
CREATE INDEX ix_risks_org_status ON risks(organization_id, status);
CREATE INDEX ix_risks_org_residual ON risks(organization_id, residual_score DESC);
CREATE INDEX ix_risks_next_review ON risks(next_review_at) WHERE status <> 'closed';

-- Treatment plan items / POA&M milestones.
CREATE TABLE risk_treatments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  risk_id          uuid NOT NULL REFERENCES risks(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','in_progress','done','cancelled')),
  due_at           timestamptz,
  completed_at     timestamptz,
  cost_estimate    numeric(14,2),
  ticket_id        uuid REFERENCES tickets(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_risk_treatments_risk ON risk_treatments(risk_id);

-- Links to evidence already held in Nexus. `ref` is text so a control id ('AC-2') and a uuid
-- (finding, ticket, …) share one table; the module validates each kind and its organization.
CREATE TABLE risk_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  risk_id          uuid NOT NULL REFERENCES risks(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('control','finding','ticket','problem','change','service')),
  ref              text NOT NULL,
  label            text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (risk_id, kind, ref)
);
CREATE INDEX ix_risk_links_risk ON risk_links(risk_id);
CREATE INDEX ix_risk_links_ref ON risk_links(kind, ref);

-- Append-only assessment history. Every score change writes a snapshot; nothing updates a row.
CREATE TABLE risk_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  risk_id             uuid NOT NULL REFERENCES risks(id) ON DELETE CASCADE,
  kind                text NOT NULL,   -- created | reassessed | status | accepted | reviewed …
  inherent_score      smallint,
  residual_score      smallint,
  target_score        smallint,
  residual_likelihood smallint,
  residual_impact     smallint,
  status              text,
  ale_p50             numeric(16,2),
  note                text,
  actor_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_risk_history_risk ON risk_history(risk_id, created_at);

-- Per-organization governance thresholds, on the 1-25 residual scale.
CREATE TABLE risk_org_settings (
  organization_id  uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  appetite_score   smallint NOT NULL DEFAULT 9  CHECK (appetite_score BETWEEN 1 AND 25),
  tolerance_score  smallint NOT NULL DEFAULT 15 CHECK (tolerance_score BETWEEN 1 AND 25),
  -- Maximum acceptance lifetime: acceptances are always time-boxed (FedRAMP: re-review yearly).
  max_acceptance_days integer NOT NULL DEFAULT 365 CHECK (max_acceptance_days BETWEEN 1 AND 1095),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (appetite_score <= tolerance_score)
);

ALTER TABLE risks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_treatments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_org_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY risks_isolation ON risks
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
CREATE POLICY risk_treatments_isolation ON risk_treatments
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
CREATE POLICY risk_links_isolation ON risk_links
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
CREATE POLICY risk_history_isolation ON risk_history
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
CREATE POLICY risk_org_settings_isolation ON risk_org_settings
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON risks, risk_treatments, risk_links, risk_org_settings TO nexus_app;
-- History is append-only for the application role.
GRANT SELECT, INSERT ON risk_history TO nexus_app;

-- ---- Permissions ----
INSERT INTO permissions (key, domain, description) VALUES
  ('risk.read',   'risk', 'View an organization''s risk register'),
  ('risk.manage', 'risk', 'Create, assess and treat risks in an organization''s register'),
  ('risk.accept', 'risk', 'Approve risk acceptances and set an organization''s risk appetite')
ON CONFLICT (key) DO NOTHING;

-- Matches seed.ts ROLES. Acceptance sits with the organization's own leadership (OrgAdmin — the
-- authorizing official in RMF terms) and the MSP's service-desk manager, NOT with the analyst who
-- writes the risk up: the person proposing an acceptance should not also be able to grant it.
INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, p.key
    FROM roles r
    JOIN (VALUES
      ('Tier2', 'risk.read'),
      ('SecurityAnalyst', 'risk.read'), ('SecurityAnalyst', 'risk.manage'),
      ('ServiceDeskManager', 'risk.read'), ('ServiceDeskManager', 'risk.manage'), ('ServiceDeskManager', 'risk.accept'),
      ('OrgAdmin', 'risk.read'), ('OrgAdmin', 'risk.manage'), ('OrgAdmin', 'risk.accept'),
      ('SecurityContact', 'risk.read')
    ) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;

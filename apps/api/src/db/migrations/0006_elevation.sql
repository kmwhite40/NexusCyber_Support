-- JIT privilege elevation + break-glass (docs/nexus/02 §E.11). Platform-internal,
-- no RLS — read via the system context (mirrors automation_rules in 0004); the API
-- layer enforces authorization. loadPrincipal() reads ACTIVE, non-expired grants to
-- augment a principal's permissions.
CREATE TABLE elevation_grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES organizations(id) ON DELETE CASCADE, -- nullable: platform scope
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_permissions  text[] NOT NULL DEFAULT '{}',
  reason               text NOT NULL,
  break_glass          boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','active','expired','revoked','rejected')),
  requested_by         uuid REFERENCES users(id),
  approver_id          uuid REFERENCES users(id),
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_elevation_user_active ON elevation_grants(user_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON elevation_grants TO nexus_app;

-- Enterprise change management + CAB quorum voting. Dedicated voting subsystem
-- (does NOT overload approvals/approval_steps, which back elevation/automation too).
-- See docs/superpowers/specs/2026-06-25-cab-voting-enterprise-change-management-design.md
-- Idempotent.

CREATE TABLE IF NOT EXISTS cab_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global default
  name text NOT NULL,
  chair_id uuid REFERENCES users(id),
  quorum int NOT NULL DEFAULT 1 CHECK (quorum >= 1),
  threshold text NOT NULL DEFAULT 'majority' CHECK (threshold IN ('majority','two_thirds','unanimous')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One default board per org, and exactly one global default (organization_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS ux_cab_boards_org_default ON cab_boards(organization_id) WHERE is_default AND organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cab_boards_global_default ON cab_boards((1)) WHERE is_default AND organization_id IS NULL;

CREATE TABLE IF NOT EXISTS cab_board_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES cab_boards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('chair','member')),
  weight int NOT NULL DEFAULT 1 CHECK (weight >= 1),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS change_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  change_id uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  voter_id uuid NOT NULL REFERENCES users(id),
  vote text CHECK (vote IN ('approve','reject','abstain')),  -- null = pending
  reason text,
  weight int NOT NULL DEFAULT 1,
  ad_hoc boolean NOT NULL DEFAULT false,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_id, voter_id)
);
CREATE INDEX IF NOT EXISTS ix_change_votes_change ON change_votes(change_id);

CREATE TABLE IF NOT EXISTS change_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  change_id uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_change_comments_change ON change_comments(change_id);

CREATE TABLE IF NOT EXISTS change_blackouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS change_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = global
  name text NOT NULL,
  change_type text NOT NULL DEFAULT 'standard' CHECK (change_type IN ('standard','normal','emergency')),
  risk text DEFAULT 'low' CHECK (risk IN ('low','medium','high')),
  impact text CHECK (impact IN ('low','medium','high')),
  likelihood text CHECK (likelihood IN ('low','medium','high')),
  description text,
  implementation_plan text,
  test_plan text,
  backout_plan text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- changes table additions
ALTER TABLE changes ADD COLUMN IF NOT EXISTS implementation_plan text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS test_plan text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS impact text CHECK (impact IN ('low','medium','high'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS likelihood text CHECK (likelihood IN ('low','medium','high'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_board_id uuid REFERENCES cab_boards(id);
ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_quorum int;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_threshold text CHECK (cab_threshold IN ('majority','two_thirds','unanimous'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS vote_deadline timestamptz;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_outcome text CHECK (pir_outcome IN ('successful','failed','rolled_back','partial'));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_notes text;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_by uuid REFERENCES users(id);
ALTER TABLE changes ADD COLUMN IF NOT EXISTS pir_at timestamptz;

-- add 'cancelled' to the status CHECK
ALTER TABLE changes DROP CONSTRAINT IF EXISTS changes_status_check;
ALTER TABLE changes ADD CONSTRAINT changes_status_check
  CHECK (status IN ('draft','cab_review','approved','scheduled','implementing','review','closed','rejected','cancelled'));

-- RLS + grants for the org-scoped new tables (mirror changes_isolation; allow global org-NULL rows).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cab_boards','change_votes','change_comments','change_blackouts','change_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format($p$CREATE POLICY %1$s_isolation ON %1$s
        USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id) OR organization_id IS NULL)
        WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id) OR organization_id IS NULL)$p$, t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nexus_app', t);
  END LOOP;
END $$;

-- cab_board_members has no organization_id; gate read/write at the app layer via its board.
ALTER TABLE cab_board_members ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY cab_board_members_isolation ON cab_board_members USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON cab_board_members TO nexus_app;

-- permissions
INSERT INTO permissions (key, domain) VALUES ('change.vote','change'), ('cab.manage','change')
  ON CONFLICT (key) DO NOTHING;
-- grant change.vote to every role that already has change.approve; cab.manage to org.manage holders
INSERT INTO role_permissions (role_id, permission_key)
  SELECT DISTINCT rp.role_id, 'change.vote' FROM role_permissions rp WHERE rp.permission_key = 'change.approve'
  ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
  SELECT DISTINCT rp.role_id, 'cab.manage' FROM role_permissions rp WHERE rp.permission_key = 'org.manage'
  ON CONFLICT DO NOTHING;

-- seed a default board per existing org (members are wired by admins via the UI / seed)
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    IF NOT EXISTS (SELECT 1 FROM cab_boards WHERE organization_id = o.id AND is_default) THEN
      INSERT INTO cab_boards (organization_id, name, quorum, threshold, is_default)
        VALUES (o.id, 'Change Advisory Board', 1, 'majority', true);
    END IF;
  END LOOP;
END $$;

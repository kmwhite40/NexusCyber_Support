-- On-call / paging engine (docs/nexus/04-sla-oncall.md §H).
-- These are Nexus-INTERNAL operational tables (rotations, pages). They are not
-- customer-readable; access is enforced at the API layer (nexus plane + oncall.*
-- capability), so RLS is intentionally not applied (cf. roles/permissions tables).
-- The runtime app role (nexus_app) receives DML via the default privileges set in 0001.

CREATE TABLE oncall_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team        text NOT NULL UNIQUE,
  tz          text NOT NULL DEFAULT 'America/New_York',
  coverage    text NOT NULL DEFAULT '24x7',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oncall_rotations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','secondary','tertiary','backup','ic')),
  length_days  int NOT NULL DEFAULT 7,
  handoff_epoch timestamptz NOT NULL,   -- anchor for deterministic rotation math
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oncall_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rotation_id  uuid NOT NULL REFERENCES oncall_rotations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  position     int NOT NULL DEFAULT 0,
  UNIQUE (rotation_id, position)
);

CREATE TABLE oncall_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  replaces_user_id uuid REFERENCES users(id),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  reason       text
);

CREATE TABLE oncall_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  ticket_id       uuid REFERENCES tickets(id),
  schedule_id     uuid NOT NULL REFERENCES oncall_schedules(id),
  severity        text NOT NULL DEFAULT 'Sev2',
  responder_id    uuid REFERENCES users(id),
  state           text NOT NULL DEFAULT 'notified'
                    CHECK (state IN ('created','notified','acknowledged','escalated','resolved')),
  ack_deadline_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_oncall_pages_state ON oncall_pages(state, created_at DESC);

CREATE TABLE oncall_acknowledgements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES oncall_pages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  acked_at    timestamptz NOT NULL DEFAULT now(),
  via         text
);

-- Explicit grants (belt-and-suspenders alongside 0001 default privileges).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  oncall_schedules, oncall_rotations, oncall_participants,
  oncall_overrides, oncall_pages, oncall_acknowledgements TO nexus_app;

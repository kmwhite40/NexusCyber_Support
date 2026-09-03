-- Offboarding shares the provisioning run tables.
--
-- Run history, the in-flight guard and per-step evidence are the same problem whether an account
-- is being created or dismantled, and solving them twice would mean two places to get RLS and
-- concurrency wrong. What must NOT be shared is the planning path — see
-- docs/superpowers/specs/2026-09-02-sbs-offboarding-design.md — so `kind` is the discriminator
-- that keeps the two flows apart in every query that must not mix them.
--
-- Additive and idempotent. `kind` defaults to 'onboarding', so every existing row and every
-- existing INSERT in modules/provisioning/index.ts keeps working untouched.

ALTER TABLE provisioning_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'onboarding',
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

ALTER TABLE provisioning_runs DROP CONSTRAINT IF EXISTS provisioning_runs_kind_check;
ALTER TABLE provisioning_runs ADD CONSTRAINT provisioning_runs_kind_check
  CHECK (kind IN ('onboarding','offboarding'));

COMMENT ON COLUMN provisioning_runs.kind IS
  'Which engine owns this run. Onboarding creates; offboarding destroys. They share these tables but never share a planner.';

COMMENT ON COLUMN provisioning_runs.scheduled_for IS
  'When an approved offboarding plan should fire — HR''s instructed instant, timezone-aware. NULL for onboarding, which executes on approval rather than on a clock.';

-- Two new run statuses:
--   'scheduled'    — approved and armed, waiting for scheduled_for.
--   'needs_review' — fired, but halted partway: either the manual mailbox step was reached, or
--                    the plan had drifted since approval so only the security steps ran.
ALTER TABLE provisioning_runs DROP CONSTRAINT IF EXISTS provisioning_runs_status_check;
ALTER TABLE provisioning_runs ADD CONSTRAINT provisioning_runs_status_check
  CHECK (status IN ('planned','scheduled','running','awaiting_cloudpc','needs_review','succeeded','failed'));

-- The sweeper claims due runs with FOR UPDATE SKIP LOCKED. Partial, so it stays small as run
-- history accumulates: only rows actually waiting to fire are ever in it.
CREATE INDEX IF NOT EXISTS provisioning_runs_due_idx
  ON provisioning_runs (scheduled_for)
  WHERE status = 'scheduled';

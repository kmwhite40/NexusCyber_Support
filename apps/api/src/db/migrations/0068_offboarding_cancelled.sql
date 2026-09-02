-- A scheduled offboarding run must be cancellable.
--
-- Phase 1 shipped with arming but no way to stop it: once a plan was armed, the only way to
-- prevent the teardown was a manual UPDATE against the production database. That is the wrong
-- shape for the one action in this system that disables a person's account at a fixed moment —
-- plans change, start dates move, people withdraw resignations.
--
-- 'cancelled' is terminal and distinct from 'failed': nothing went wrong, a human decided not to
-- proceed, and the run history should say so.
ALTER TABLE provisioning_runs DROP CONSTRAINT IF EXISTS provisioning_runs_status_check;
ALTER TABLE provisioning_runs ADD CONSTRAINT provisioning_runs_status_check
  CHECK (status IN (
    'planned','scheduled','running','awaiting_cloudpc',
    'needs_review','succeeded','failed','cancelled'
  ));

-- Close the arming race the offboarding guard left open.
--
-- Migration 0057 explains why a conditional INSERT is necessary but NOT sufficient: under READ
-- COMMITTED two concurrent requests can both evaluate NOT EXISTS before either commits, so the
-- application guard is statistical and this index is the structural one.
--
-- The offboarding schedule() copied layer 1 and not layer 2. This index's predicate was
-- ('running','awaiting_cloudpc') and did not include 'scheduled', so two concurrent schedules
-- BOTH inserted. The next sweep then claimed both rows into 'running' in a single UPDATE,
-- violating this very index, aborting the batch — and throwing on every subsequent tick, so NO
-- offboarding would fire at all until someone repaired the rows by hand. A duplicate-arming bug
-- that escalates into a total outage of the feature.
--
-- The predicate now matches IN_FLIGHT_OFFBOARD_STATUSES in modules/offboarding/index.ts exactly.
-- Keep the two in step: layer 1 and layer 2 disagreeing is what caused this.
--
-- 'awaiting_cloudpc' stays for the onboarding flow, which is the only thing that uses it.
--
-- COLLAPSE EXISTING DUPLICATES FIRST. This is not hypothetical tidiness: the API runs with
-- RUN_MIGRATIONS_ON_BOOT=true, so a CREATE UNIQUE INDEX that fails on pre-existing duplicate
-- rows does not merely skip the migration — it aborts startup and the service does not come up
-- at all. Any ticket that already has more than one in-flight run keeps its EARLIEST (that is
-- the one whose approval someone actually read) and the rest are cancelled with a reason, rather
-- than deleted: they are part of the record of what was armed.
UPDATE provisioning_runs r
   SET status = 'cancelled',
       finished_at = now(),
       error = 'cancelled: superseded — this ticket had more than one in-flight run when the one-run-per-ticket index was tightened (0071)'
 WHERE r.status IN ('scheduled', 'running', 'awaiting_cloudpc')
   AND EXISTS (
     SELECT 1 FROM provisioning_runs keep
      WHERE keep.ticket_id = r.ticket_id
        AND keep.status IN ('scheduled', 'running', 'awaiting_cloudpc')
        AND (keep.created_at, keep.id) < (r.created_at, r.id)
   );

DROP INDEX IF EXISTS provisioning_runs_one_inflight_per_ticket;
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_runs_one_inflight_per_ticket
  ON provisioning_runs (ticket_id)
  WHERE status IN ('scheduled', 'running', 'awaiting_cloudpc');

COMMENT ON INDEX provisioning_runs_one_inflight_per_ticket IS
  'Structural half of the one-run-per-ticket guard (0057). Predicate MUST match IN_FLIGHT_OFFBOARD_STATUSES and the onboarding IN_FLIGHT_RUN_STATUSES; a conditional INSERT alone is statistical under READ COMMITTED.';

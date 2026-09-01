-- At most ONE in-flight provisioning run per ticket, enforced by the database.
--
-- The service already refuses a second run with a conditional INSERT ... WHERE NOT EXISTS
-- (see IN_FLIGHT_RUN_STATUSES in ../../modules/provisioning/index.ts), which returns a clean
-- 409. That guard is the friendly first line and stays. It cannot, however, survive two truly
-- concurrent requests: under READ COMMITTED both can evaluate NOT EXISTS before either has
-- committed, and both then insert.
--
-- Why that narrow window is worth an index rather than a note in a report: the executor's
-- per-step idempotency bounds a RETRIED run (it adopts the user Graph already created), but it
-- does nothing for two runs racing — each independently POSTs to
-- /authentication/temporaryAccessPassMethods and mints its OWN Temporary Access Pass. The
-- failure mode is a second live credential on a brand-new federal identity, not a duplicate
-- row. This makes that structurally impossible instead of statistically unlikely.
--
-- 'planned' is deliberately NOT in the predicate: it is a never-started run and must not block
-- a real one. 'succeeded' and 'failed' are finished, and retrying a finished run is expected
-- (0056: "Retrying creates a NEW run; history is never overwritten").
--
-- IF NOT EXISTS because migrate.ts runs every file on API boot until it is recorded, and a
-- half-applied deployment must be able to re-run this without erroring.
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_runs_one_inflight_per_ticket
  ON provisioning_runs (ticket_id)
  WHERE status IN ('running', 'awaiting_cloudpc');

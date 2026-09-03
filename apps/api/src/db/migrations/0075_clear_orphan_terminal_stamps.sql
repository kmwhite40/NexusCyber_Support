-- Clears resolved_at/closed_at on tickets that are no longer in a terminal status.
--
-- transition() now clears these when a ticket leaves resolved/closed, but rows written BEFORE
-- that fix kept the stamp: production has one ticket sitting at in_progress while still carrying
-- the resolved_at from an earlier resolve. A code fix cannot reach rows already written, and such
-- a row reads as resolved and open at the same time — the exact confusion this all started with
-- ("I have resolved tickets and they still sit there as if they're open").
--
-- Analytics and SLA reporting read resolved_at, so a stamp on a ticket nobody resolved skews
-- resolution timing for work that is still open.
--
-- Forward-only and idempotent: it corrects existing rows and is a no-op on a clean database.

UPDATE tickets
   SET resolved_at = NULL
 WHERE status NOT IN ('resolved', 'closed')
   AND resolved_at IS NOT NULL;

UPDATE tickets
   SET closed_at = NULL
 WHERE status <> 'closed'
   AND closed_at IS NOT NULL;

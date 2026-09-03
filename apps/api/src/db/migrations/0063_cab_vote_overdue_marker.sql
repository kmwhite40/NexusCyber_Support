-- Durable "already notified" marker for the CAB deadline sweeper (task 8, spec
-- 2026-06-25). The sweeper runs every few minutes and finds `cab_review` changes past
-- `vote_deadline` with quorum unmet; it must fire `change.vote_overdue` to the chair
-- exactly ONCE per change, not once per tick.
--
-- An in-memory Set (as sla-sweeper.ts uses for warning/breach) is NOT reused here on
-- purpose: SLA state is re-derived from due_at on every tick and a duplicate warning/
-- breach after a restart is a one-time, same-severity repeat of information already
-- sent. A CAB vote_deadline is measured in BUSINESS DAYS (voteDeadlineFor: +3 business
-- days normal, +4h emergency) and a `cab_review` change can sit overdue for a long
-- time relative to how often the API process restarts (deploys, container recycles).
-- An in-memory guard would re-page the chair on every restart for as long as the
-- change stays overdue and unresolved by the board -- noisy exactly when the signal
-- ("the board never showed up") should stay quiet after the first ping. A durable
-- marker column survives restarts and fires the notification once for the lifetime of
-- the change, at the cost of one column. Idempotent.

ALTER TABLE changes ADD COLUMN IF NOT EXISTS vote_overdue_notified_at timestamptz;

COMMENT ON COLUMN changes.vote_overdue_notified_at IS
  'Set once by the CAB deadline sweeper (jobs/cab-deadline-sweeper.ts) the first time it finds this change cab_review, past vote_deadline, and quorum unmet. Prevents re-notifying the chair on every sweep tick, and survives process restarts (unlike an in-memory guard). NULL until then; never cleared automatically -- a fresh submit-cab resets vote_deadline (and would need a fresh overdue signal only if it goes overdue again, which a future re-submission path should reset alongside vote_deadline).';

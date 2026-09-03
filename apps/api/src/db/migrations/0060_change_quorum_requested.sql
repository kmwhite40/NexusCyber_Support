-- Persist the CAB quorum a board ASKED for, alongside the effective quorum it votes at.
--
-- `snapshotQuorum` clamps a board's configured quorum down to the eligible roster so a
-- board that has shrunk (an ECAB cut, a recused raiser, departed members) cannot deadlock
-- in `cab_review` forever. That clamp WEAKENS the board's own decision rule, so it must
-- never be silent. Until now it survived only in the submit-cab response and the audit
-- detail, which means a voter opening the change later saw a quorum of 1 with nothing to
-- say it had been 3 — exactly the "buried" case.
--
-- Storing the requested value on the change makes the clamp visible in the vote tally to
-- everyone voting, for the whole life of the change. NULL on changes submitted before this
-- migration (and on standard changes, which never reach the CAB); the UI treats NULL as
-- "unknown, show nothing" rather than "not clamped". Idempotent.

ALTER TABLE changes ADD COLUMN IF NOT EXISTS cab_quorum_requested int;

COMMENT ON COLUMN changes.cab_quorum_requested IS
  'Board-configured quorum at submit time, before clamping to the eligible roster. cab_quorum > this is impossible; cab_quorum < this means the quorum was weakened.';

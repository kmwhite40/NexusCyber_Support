-- Repair ticket numbers and organization names that carry stray whitespace, and stop it
-- recurring.
--
-- An organization signed up as " Strategic Business Systems (Federal)" — leading space, never
-- trimmed — and ticketNumberPrefix took the first four characters of the raw name, producing
-- " STR". Every ticket that org raised was stored as " STR-000001" and mailed out as
-- "[ STR-000001] ...". The prefix function was later fixed to strip non-alphanumerics first,
-- but that was a CODE fix: the rows already written kept the bad value.
--
-- Those rows are not cosmetically wrong, they are functionally broken. Mail-ingest threading
-- pulls "STR-000001" out of a reply subject with a \b-anchored regex and looks it up with
-- `ticket_number = $2`. Against a stored " STR-000001" that comparison fails, so a customer
-- replying to one of those tickets silently opens a NEW ticket instead of threading onto theirs.
--
-- Idempotent.

-- 1. The root cause. The prefix is derived from this, and an untrimmed name also renders wrong
--    everywhere it is displayed.
UPDATE organizations SET name = btrim(name) WHERE name <> btrim(name);

-- 2. The affected rows. If a trim would collide with an existing number in the same org, this
--    statement errors and the whole migration rolls back — deliberately. That would mean two
--    tickets are claiming one identifier, which a human must resolve rather than a migration
--    picking a winner.
UPDATE tickets SET ticket_number = btrim(ticket_number) WHERE ticket_number <> btrim(ticket_number);

-- 3. Stop it coming back through any other write path. Cheap to enforce, and the failure mode it
--    prevents is silent.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_ticket_number_trimmed;
ALTER TABLE tickets ADD CONSTRAINT tickets_ticket_number_trimmed
  CHECK (ticket_number = btrim(ticket_number));

COMMENT ON CONSTRAINT tickets_ticket_number_trimmed ON tickets IS
  'Ticket numbers are matched exactly by mail-reply threading; leading or trailing whitespace silently breaks that match and orphans the reply into a new ticket.';

-- NOTE, deliberately not done here: the two repaired rows keep the ' STR' -> 'STR' prefix while
-- tickets raised after the code fix get 'STRA'. Renumbering existing tickets would invalidate
-- identifiers already sent to customers by email, which is worse than a cosmetic inconsistency
-- in the prefix.

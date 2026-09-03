-- Operations / on-call hardening:
--  - users.phone: cell number for on-call responders (paging contact).
--  - oncall_pages.schedule_id was created without ON DELETE behavior, so deleting a
--    schedule with historical pages would fail. Cascade closed pages with the schedule so
--    a schedule can be deleted cleanly (the API still blocks deletion while pages are OPEN).
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE oncall_pages DROP CONSTRAINT IF EXISTS oncall_pages_schedule_id_fkey;
ALTER TABLE oncall_pages
  ADD CONSTRAINT oncall_pages_schedule_id_fkey
  FOREIGN KEY (schedule_id) REFERENCES oncall_schedules(id) ON DELETE CASCADE;

-- SLA pause/resume + holiday calendars (docs/nexus/04 §H.4). sla_instances already carries
-- state='paused' and paused_minutes from 0001; this adds paused_at to track when a pause
-- began, and a holidays array on business_calendars so the engine skips holiday days.
ALTER TABLE sla_instances ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE business_calendars ADD COLUMN IF NOT EXISTS holidays date[] NOT NULL DEFAULT '{}';

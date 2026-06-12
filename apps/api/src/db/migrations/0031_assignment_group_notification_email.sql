-- Shared service-desk mailbox per assignment group (docs/nexus/06 §K).
-- New tickets notify the owning team via ONE shared address instead of emailing
-- every covering agent. NULL falls back to the platform default (SERVICE_DESK_EMAIL).
ALTER TABLE assignment_groups ADD COLUMN IF NOT EXISTS notification_email text;

-- Serializes device-sync runs per organization.
--
-- The scheduler already refuses to overlap itself, but that flag lives in one process's memory.
-- It does not stop an admin's "Sync now" landing mid-sweep for the same org, and two interleaved
-- runs can retire a real device: run A enumerates, run B enumerates and upserts a device A never
-- saw, then A's retirement pass sees that device in the database, not in its own (older)
-- enumeration, and retires it. Self-healing on the next run, but wrong in the meantime — and
-- wrongly retiring devices is the failure this feature works hardest to avoid.
--
-- A lease rather than an advisory lock, deliberately: enumerating a tenant is minutes of HTTP,
-- and an advisory lock would mean holding a pooled database connection for all of it. The lease
-- is a row, so nothing is held, and an expiry means a crashed process cannot wedge an org
-- forever — the one failure mode a lock table has that a lock does not.

ALTER TABLE org_integrations
  ADD COLUMN IF NOT EXISTS sync_lease_owner text,
  ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz;

COMMENT ON COLUMN org_integrations.sync_lease_until IS
  'Expiry of the current sync claim. NULL or in the past means the org is free to sync. An expired lease is reclaimable: a process that died mid-sync must not lock the org out permanently.';

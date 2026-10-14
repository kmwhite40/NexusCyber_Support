-- Bring the SYSTEM-PROVIDED workflows in line with the built-in transition map.
--
-- Why this migration exists at all: resolveTransitions() prefers a stored workflow over the
-- built-in DEFAULT_TRANSITIONS map, and 0020 seeded a global incident workflow mirroring the
-- map as it stood then. So changing the map in code is a NO-OP for any ticket type that has a
-- stored workflow — which 'incident' does, and which is the default type for every ticket an
-- integration creates. Two changes shipped as exactly that kind of no-op:
--
--   * closed -> reopened. An external GRC system owns the finding, not Anchor; Anchor reports
--     that work was done and the finding closes only on re-collected evidence. When
--     reassessment fails the SAME ticket must reopen, repeatedly, or the integration mints a
--     new ticket each cycle and the remediation history is lost on the item that needed it.
--   * the `blocked` state (phase D). A backlog item could be CREATED blocked, because creation
--     sets the status directly, but could never be transitioned OUT of it.
--
-- Scope: organization_id IS NULL only. A customer-authored workflow is their configuration and
-- is not rewritten here; they opt in through the workflows API.
INSERT INTO workflow_transitions (workflow_id, from_status, to_status)
SELECT w.id, t.from_status, t.to_status
  FROM workflows w
 CROSS JOIN (VALUES
     ('closed','reopened'),
     ('assigned','blocked'),
     ('in_progress','blocked'),
     ('blocked','in_progress'),
     ('blocked','assigned')
   ) AS t(from_status, to_status)
 WHERE w.organization_id IS NULL
ON CONFLICT (workflow_id, from_status, to_status) DO NOTHING;

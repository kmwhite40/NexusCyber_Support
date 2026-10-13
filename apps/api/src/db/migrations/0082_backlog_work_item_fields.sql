-- Phase D of the external integration contract (ADR-0016): agile backlog attributes, so a
-- programme's build work imports at full fidelity instead of being flattened into labels.
--
-- These are Jira Software concepts, not Jira Service Management ones. Anchor already had broad
-- JSM parity (queues, SLAs, workflows, request types, approvals, CAB, problems, on-call); what
-- it had no model for was epic->story hierarchy, estimates and backlog ordering.
ALTER TABLE tickets
  -- The caller's own key for this item's parent. Kept as text ALONGSIDE parent_ticket_id so a
  -- child that arrives before its epic is not rejected: the link resolves later, in either
  -- direction, without the caller having to order its payload or re-sync.
  ADD COLUMN parent_external_ref text,
  -- The caller's own priority scheme (P0/P1/P2 for a build backlog). Deliberately NOT the
  -- tickets.priority column: that is derived from impact x urgency and drives SLA targets and
  -- escalation. "P0 blocks the MVP" is not a security severity and must never reach that logic.
  ADD COLUMN external_priority text,
  ADD COLUMN estimate_days numeric(6,2),
  -- The programme phase ('1','2','3','post-mvp'). Named work_phase because a bare `phase` on a
  -- 40-column tickets table reads as a workflow or SLA phase.
  ADD COLUMN work_phase text,
  ADD COLUMN workstream text,
  ADD COLUMN acceptance_criteria text,
  ADD COLUMN blocked_reason text;

-- Resolving a deferred parent link means asking "which tickets are waiting on MY external_ref?"
-- on every create. Without this that is a sequential scan of tickets per import.
CREATE INDEX ix_tickets_parent_external_ref
  ON tickets(organization_id, parent_external_ref) WHERE parent_external_ref IS NOT NULL;

CREATE INDEX ix_tickets_workstream ON tickets(organization_id, workstream) WHERE workstream IS NOT NULL;

COMMENT ON COLUMN tickets.external_priority IS
  'The integration''s own priority value (e.g. P0-P2). Never drives SLA, routing or escalation.';
COMMENT ON COLUMN tickets.parent_external_ref IS
  'The caller''s external_ref for this item''s parent; resolved to parent_ticket_id when that ticket exists.';

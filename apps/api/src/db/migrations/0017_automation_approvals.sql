-- Automation gated-action approvals (docs/nexus/07 §M). When a published rule fires a
-- customer-visible/destructive (gated) action, the engine records a pending execution and
-- an approval instead of acting; on approval the gated actions are performed. These columns
-- let a pending execution carry the target ticket and link to its approval.
ALTER TABLE automation_executions ADD COLUMN IF NOT EXISTS ticket_id uuid;
ALTER TABLE automation_executions ADD COLUMN IF NOT EXISTS approval_id uuid;
CREATE INDEX IF NOT EXISTS ix_automation_exec_outcome ON automation_executions(outcome);

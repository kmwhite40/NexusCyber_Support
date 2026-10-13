-- Typed homes for the external GRC integration's item fields (ADR-0016, phase A').
-- Before this, POST /api/v1/tickets' non-strict zod schema dropped dueDate/owner/controlIds/
-- sourceId/carbonUrl on the floor and returned 201, so a caller could sync for months while
-- its due dates went nowhere. Names are deliberately vendor-neutral (external_url, not
-- carbon_url) so a second integration reuses them rather than adding its own column.
ALTER TABLE tickets
  ADD COLUMN external_due_at    timestamptz,
  ADD COLUMN external_owner     text,
  ADD COLUMN external_source_id text,
  ADD COLUMN control_ids        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN external_url       text;

-- external_due_at is the CALLER's remediation deadline. It is deliberately NOT
-- resolution_due_at, which is Anchor's SLA clock — conflating them would corrupt SLA
-- reporting and mislead the caller about which deadline it is reading.
COMMENT ON COLUMN tickets.external_due_at IS
  'Remediation deadline supplied by an external integration; distinct from the SLA clock.';

-- external_source_id is the caller's own id for the underlying item: a stable handle that
-- survives a change to the external_ref string format (which the consumer duplicates on
-- their side and warns may change).
COMMENT ON COLUMN tickets.external_source_id IS
  'The external system''s id for the source item, independent of external_ref formatting.';

-- "Which tickets touch CA-7?" is a real GRC reporting question, which is why control ids are
-- a queryable array rather than tags (a user-facing labelling field with other semantics).
CREATE INDEX ix_tickets_control_ids ON tickets USING gin(control_ids);

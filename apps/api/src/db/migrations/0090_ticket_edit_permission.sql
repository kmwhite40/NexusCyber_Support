-- ticket.edit: correct a ticket's own fields (PATCH /tickets/:id): subject, description,
-- category, impact and urgency (priority is re-derived, and running SLA clocks re-targeted).
--
-- A NEW verb rather than riding on ticket.update, which every tier holds for status work.
-- Rewriting what a ticket says, or its priority (and therefore its SLA deadline), is an
-- administrative correction, so it is a service-desk-manager action and audited.
-- Reassignment stays on the existing ticket.assign verb.
--
-- Granted to ServiceDeskManager. SuperAdmin already holds it through admin.superuser. Dual-written
-- into seed.ts (PERMISSIONS + the ServiceDeskManager role list): seed DELETEs and rebuilds
-- role_permissions, so a grant that lived only here would be stripped by the next re-seed.
-- Idempotent.
INSERT INTO permissions (key, domain, description) VALUES
  ('ticket.edit', 'ticket', 'Edit a ticket''s subject, description, category, impact and urgency')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'ticket.edit' FROM roles r WHERE r.key = 'ServiceDeskManager'
ON CONFLICT DO NOTHING;

-- ticket.form.edit: correct the answers on a submitted catalog request (PATCH /tickets/:id/form).
--
-- Deliberately a NEW verb rather than riding on ticket.update, which every tier holds. Editing a
-- submitted request rewrites what fulfilment acts on — the onboarding UPN, supervisor, groups,
-- the offboarding departing user — so it is a service-desk-manager action, audited, and refused
-- while a provisioning/offboarding run is in flight.
--
-- Granted to ServiceDeskManager. SuperAdmin already holds it through admin.superuser. Dual-written
-- into seed.ts (PERMISSIONS + the ServiceDeskManager role list): seed DELETEs and rebuilds
-- role_permissions, so a grant that lived only here would be stripped by the next re-seed.
-- Idempotent.
INSERT INTO permissions (key, domain, description) VALUES
  ('ticket.form.edit', 'ticket', 'Correct the answers on a submitted catalog request form')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'ticket.form.edit' FROM roles r WHERE r.key = 'ServiceDeskManager'
ON CONFLICT DO NOTHING;

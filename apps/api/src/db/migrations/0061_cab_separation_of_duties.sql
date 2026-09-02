-- CAB separation of duties. Closes the two ways the board could be bypassed or packed by
-- the very person it exists to check. Idempotent.
--
-- 1. SELF-CLASSIFICATION. `change_type = 'standard'` means PRE-APPROVED: submit-cab returns
--    `approved` with zero votes. Until now any `change.create` holder could simply declare
--    their own change standard. Pre-approval is a CAB act, so it is now carried by a
--    `change_templates` row (authored under `cab.manage`), and the change records which
--    template granted it. ON DELETE SET NULL: retiring a template must not block deleting
--    it, and a draft that loses its provenance is refused at submit rather than waved
--    through (see submitForCab).
--
-- 2. ROLE OVERLAP. A role that can RAISE a change (`change.create`) must not also be able
--    to COMPOSE the board that judges it (`cab.manage`) — with both, a raiser can add an
--    ally to the board, set quorum 1, and submit. Today exactly one role holds both
--    (ServiceDeskManager). The CAB-administration half is the one the role is named for,
--    so `change.create` is what is revoked; a service desk manager now asks an engineer
--    (Tier2 / SecurityAnalyst, who hold `change.create`) to raise the change.
--    Roles carrying the platform superuser wildcard are left alone: they are outside the
--    SoD model by construction and their CAB writes are audited individually.
--    The app layer enforces the same rule at runtime (cab.ts `raisesChanges`), so stacking
--    a raiser role onto a CAB administrator does not reopen this.

-- ---- 1. pre-approval provenance ----
ALTER TABLE changes ADD COLUMN IF NOT EXISTS standard_template_id uuid
  REFERENCES change_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN changes.standard_template_id IS
  'The pre-approved change_templates row that authorised this change to be `standard` (skip the CAB). NULL on every non-standard change; a `standard` change with NULL here has no pre-approval and is refused at submit-cab.';

-- A template is a pre-approval record when its change_type is 'standard', so that must be
-- a deliberate choice rather than the value you get by not thinking about it.
ALTER TABLE change_templates ALTER COLUMN change_type SET DEFAULT 'normal';

-- ---- 2. separation of duties between raising and CAB administration ----
DELETE FROM role_permissions rp
 WHERE rp.permission_key = 'change.create'
   AND EXISTS (SELECT 1 FROM role_permissions m
                WHERE m.role_id = rp.role_id AND m.permission_key = 'cab.manage')
   AND NOT EXISTS (SELECT 1 FROM role_permissions s
                    WHERE s.role_id = rp.role_id AND s.permission_key = 'admin.superuser');

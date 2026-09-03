-- Reclassify the pre-approvals that predate 0061. A NEW file, not an edit to 0061: the
-- runner records by filename and never re-runs an applied migration. Idempotent.
--
-- 0052 created `change_templates.change_type` with DEFAULT 'standard', and the old
-- `createTemplate` inherited that default, so on any database migrated before 0061 EVERY
-- existing template is a standing pre-approval — including any authored by a
-- ServiceDeskManager while that role still held `change.create`. 0061 flipped the default and
-- bound `standard` changes to a template, but left existing rows alone, so the hole it closed
-- stayed open on the only data that matters: the live one. The new raiser-facing template
-- picker then offers every one of those rows as a CAB-skipping option.
--
-- Reclassifying to 'normal' is the safe failure direction: it costs a CAB vote on work that
-- may genuinely have been pre-approved, where the alternative costs a production change that
-- skips the board entirely. A real pre-approval is cheap to re-declare deliberately under
-- `cab.manage`, and that deliberate re-declaration is exactly the point.
--
-- Blanket, not "rows created before 0061": 0061 and this file apply in the same migration
-- run on every database that has not seen either (fresh, CI, and the live deployment), so the
-- narrower predicate selects the identical set while adding a dependency on the migration
-- ledger's own timestamps. Templates authored deliberately AFTER this runs keep their type.
UPDATE change_templates SET change_type = 'normal' WHERE change_type = 'standard';

-- Standard changes still in DRAFT predate `standard_template_id`, so they carry no
-- pre-approval and `submitForCab` would refuse them (403) with no way forward but deleting
-- and re-raising. Route them through the CAB instead: `normal` is what they would have been
-- had self-classification never been possible.
--
-- Drafts only. A standard change that is already approved/scheduled/implementing/closed is a
-- historical record of a decision that was made under the old rules; rewriting its type would
-- falsify the audit trail without changing anything about its outcome.
UPDATE changes SET change_type = 'normal', updated_at = now()
 WHERE change_type = 'standard' AND status = 'draft';

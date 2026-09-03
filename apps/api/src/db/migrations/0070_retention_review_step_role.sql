-- Repair the retention-review catalog item's fulfillment steps.
--
-- Migration 0069 wrote its steps keyed `"tier"`. Catalog steps are keyed `"role"` — that is what
-- seed.ts's step() helper emits and what the fulfillment checklist reads. On a database where
-- seed runs, seed's upsert overwrites the migration's version and the mistake is invisible. In
-- PRODUCTION seed is deliberately not run, so 0069's version stands and every step on that item
-- lands with a null assignee role.
--
-- BOTH halves were done, deliberately:
--   * 0069's source was corrected, so a FRESH install writes the right key from the start and
--     never needs this repair.
--   * THIS migration repairs databases where 0069 already ran with the wrong key — production
--     among them, since it applied 0069 on 2026-09-03.
--
-- Editing an already-applied migration is normally wrong, because the file stops describing what
-- actually ran. It is noted here so the divergence is discoverable: if you are comparing prod's
-- catalog row against 0069's text and they disagree, this is why. The WHERE clause makes this a
-- no-op on any database that got the corrected 0069.
UPDATE service_catalog_items
   SET fulfillment_steps = '[
     {"key":"verify","label":"Verify the account state against the hold record","role":"Tier2","automatable":false},
     {"key":"decide","label":"Decide disposition and record the reason","role":"Tier2","automatable":false},
     {"key":"close","label":"Close the hold","role":"Tier2","automatable":false}
   ]'::jsonb
 WHERE key = 'security.retention_review'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(fulfillment_steps) s WHERE s ? 'tier'
   );

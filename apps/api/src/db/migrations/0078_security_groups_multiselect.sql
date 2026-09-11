-- "Security / distribution groups" was a free-text textarea (0037). In practice that meant the
-- requester typed group names from memory — so a mistyped one became a group_missing blocker
-- after the request had already been approved, and far more often the box was simply left blank
-- and the new hire was provisioned into no groups at all.
--
-- It becomes a multi-select over the tenant's REAL groups, served live by
-- GET /api/v1/provisioning/groups (options_source='entra_groups'), the same mechanism
-- cloud_pc_policy already uses. The static options list stays empty by design: a live-sourced
-- field is exempt from the static check in modules/forms.ts, and what the chosen names refer to
-- is settled downstream by the provisioning planner against the tenant's actual groups.
--
-- Answers stored by earlier requests are NOT migrated. They are comma- or newline-separated
-- strings and they still have to plan, so planner.ts reads both shapes rather than rewriting
-- history in place — a stored answer is what the requester actually submitted.
-- form_fields.data_type is CHECK-constrained to a fixed vocabulary, so 'multiselect' has to be
-- admitted before any row can use it. Without this the UPDATE below violates the constraint, the
-- migration fails, and RUN_MIGRATIONS_ON_BOOT turns that into an API that will not start.
-- Rebuilt rather than edited in place (same reasoning as 0065): there is no ADD VALUE for a
-- CHECK, and listing the full set keeps the allowed vocabulary readable in one place.
ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN (
    'text','textarea','number','select','multiselect','checkbox','date','datetime',
    'user','user_multi','attachment','email','phone'
  ));

DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='user_onboarding' AND organization_id IS NULL;
  IF f IS NULL THEN RAISE NOTICE 'user_onboarding form missing; 0037 must run first'; RETURN; END IF;

  UPDATE form_fields
     SET data_type='multiselect', options='[]'::jsonb, options_source='entra_groups'
   WHERE form_id=f AND key='security_groups';
END $$;

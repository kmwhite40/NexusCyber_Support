-- The offboarding intake asked for a bare date, but the runbook says the account must be blocked
-- "at the date and time HR has instructed" and the sweeper fires on an instant. YYYY-MM-DD
-- cannot express "5pm Friday".
--
-- The timezone lives IN the value: the datetime validator (modules/forms.ts) requires a zone
-- designator, so 2026-09-05T17:00:00-04:00 is unambiguous on its own. A separate timezone field
-- would be a second source of truth for one fact, with nothing to say which wins when the two
-- disagree.
--
-- Idempotent, and a no-op on a database where the form does not exist.

-- form_fields.data_type is CHECK-constrained to a fixed vocabulary, so the new type has to be
-- admitted before any row can use it. Rebuilt rather than edited in place: there is no ADD VALUE
-- for a CHECK, and listing the full set keeps the allowed vocabulary readable in one place.
ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN (
    'text','textarea','number','select','checkbox','date','datetime',
    'user','user_multi','attachment','email','phone'
  ));

DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key = 'm365_offboard' AND organization_id IS NULL;
  IF f IS NULL THEN RETURN; END IF;

  UPDATE form_fields
     SET data_type = 'datetime',
         label = 'Disable effective (date and time, with timezone)'
   WHERE form_id = f AND key = 'disable_effective';
END $$;

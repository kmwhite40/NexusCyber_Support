-- Fix the onboarding ticket subject.
--
-- 0054 deleted `new_employee_name`, which had carried maps_to='subject', and moved that
-- mapping onto `legal_first_name` alone — so every onboarding ticket was titled with a bare
-- first name ("John"). mapFormAnswers now COMPOSES the subject from every field carrying
-- maps_to='subject', joined with a space in field-position order, so the fix here is data:
-- give `legal_last_name` the same mapping and order the two fields first-then-last.
--
-- Idempotent: pure UPDATEs, safe to re-apply; a no-op when 0054 never ran (0 rows matched).
DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='user_onboarding' AND organization_id IS NULL;
  IF f IS NULL THEN RAISE NOTICE 'user_onboarding form missing; 0037/0054 must run first'; RETURN; END IF;

  -- First name renders (and composes) before last name -> subject "John Doe", not "Doe John".
  UPDATE form_fields SET maps_to='subject', position=15 WHERE form_id=f AND key='legal_first_name';
  UPDATE form_fields SET maps_to='subject', position=16 WHERE form_id=f AND key='legal_last_name';
END $$;

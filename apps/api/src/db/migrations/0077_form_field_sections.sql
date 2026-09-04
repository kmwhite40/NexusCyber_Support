-- Grouping (and reordering) for long request forms.
--
-- The onboarding intake carries 34 fields and renders as one flat list in a dialog. A design
-- critique flagged the cognitive load; reading the actual field order showed something worse than
-- crowding. The order is itself wrong: a requester meets "Additional notes" and "Approvers" at
-- positions 13-14, then is asked the new hire's NAME at 15, and their home address at 33. The
-- form asks for the trailing details before the subject of the request.
--
-- So this does two things, and the second is the one worth being explicit about: it adds a
-- section heading per field, AND RENUMBERS POSITIONS so each section is contiguous. Grouping
-- without reordering would have produced headings that repeat as the form jumps between them,
-- which is worse than no headings at all.
--
-- Field keys, labels, requiredness and visible_when are untouched — every saved answer keeps its
-- meaning, and nothing that reads custom_fields is affected. Only presentation order changes.
--
-- A column rather than a client-side grouping, because these forms are data: a hardcoded map in
-- the web app would stop matching the moment anyone edits a form in the form builder.
-- NULL stays valid and means ungrouped; short forms are worse with headings than without, so the
-- offboarding intake is deliberately left alone.

ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS section text;

COMMENT ON COLUMN form_fields.section IS
  'Optional heading this field groups under when the form is rendered. NULL = ungrouped.';

DO $$
DECLARE f uuid;
BEGIN
  SELECT id INTO f FROM request_forms WHERE key='user_onboarding' AND organization_id IS NULL;
  IF f IS NULL THEN RETURN; END IF;

  UPDATE form_fields SET section='The request' WHERE form_id=f AND key IN ('on_behalf_of','start_date');
  UPDATE form_fields SET section='The person'  WHERE form_id=f AND key IN
    ('legal_first_name','legal_last_name','middle_name','preferred_first_name','employee_id',
     'personal_email','cell_phone','home_address_street','home_address_csz');
  UPDATE form_fields SET section='The role'    WHERE form_id=f AND key IN
    ('job_title','department','employment_type','supervisor','hire_type','request_kind',
     'replacement_for','end_date','access_type');
  UPDATE form_fields SET section='Where they work' WHERE form_id=f AND key IN
    ('work_location','duty_location','location');
  UPDATE form_fields SET section='Accounts and access' WHERE form_id=f AND key IN
    ('email_account','license_bundle','security_groups','copy_from','mfa_method','cloud_pc_policy');
  UPDATE form_fields SET section='Equipment'   WHERE form_id=f AND key IN ('hardware');
  UPDATE form_fields SET section='Anything else' WHERE form_id=f AND key IN ('notes','approvers');

  -- Renumber so each section is contiguous, keeping each field's order WITHIN its section.
  -- Sections run in the order the request is actually thought about: who is asking, who the
  -- person is, what they do, where, what they get, what hardware, then anything left over.
  WITH ordered AS (
    SELECT ff.id,
           row_number() OVER (
             ORDER BY CASE ff.section
               WHEN 'The request' THEN 1 WHEN 'The person' THEN 2 WHEN 'The role' THEN 3
               WHEN 'Where they work' THEN 4 WHEN 'Accounts and access' THEN 5
               WHEN 'Equipment' THEN 6 WHEN 'Anything else' THEN 7 ELSE 8 END,
               ff.position
           ) AS pos
      FROM form_fields ff WHERE ff.form_id = f
  )
  UPDATE form_fields ff SET position = o.pos FROM ordered o WHERE ff.id = o.id;
END $$;

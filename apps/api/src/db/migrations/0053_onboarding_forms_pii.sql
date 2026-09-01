-- Part A: forms subsystem — conditional visibility, sensitive fields, server-sourced options.
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS visible_when jsonb;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS options_source text;

ALTER TABLE form_fields DROP CONSTRAINT IF EXISTS form_fields_data_type_check;
ALTER TABLE form_fields ADD CONSTRAINT form_fields_data_type_check
  CHECK (data_type IN ('text','textarea','number','select','checkbox','date',
                       'user','user_multi','attachment','email','phone'));

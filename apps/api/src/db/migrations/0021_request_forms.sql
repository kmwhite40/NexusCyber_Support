-- Custom request forms & field definitions (JSM parity). A form is a set of typed fields
-- bound to a ticket type / catalog request; answers are validated and stored on
-- tickets.custom_fields. Global (organization_id NULL) or org-scoped.
CREATE TABLE request_forms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global
  key             text NOT NULL,
  name            text NOT NULL,
  ticket_type     text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE form_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id     uuid NOT NULL REFERENCES request_forms(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  data_type   text NOT NULL DEFAULT 'text'
                CHECK (data_type IN ('text','textarea','number','select','checkbox','date')),
  required    boolean NOT NULL DEFAULT false,
  options     jsonb NOT NULL DEFAULT '[]',  -- for select fields
  position    int NOT NULL DEFAULT 0,
  UNIQUE (form_id, key)
);
CREATE INDEX ix_form_fields_form ON form_fields(form_id);

ALTER TABLE request_forms ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_forms_isolation ON request_forms
  USING (organization_id IS NULL OR organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON request_forms, form_fields TO nexus_app;

-- Seed a global sample form for new-user access requests (created_by NULL = system).
DO $$
DECLARE f uuid;
BEGIN
  INSERT INTO request_forms (organization_id, key, name, ticket_type)
  VALUES (NULL, 'new_user_access', 'New user access request', 'access_request')
  RETURNING id INTO f;
  INSERT INTO form_fields (form_id, key, label, data_type, required, options, position) VALUES
    (f, 'full_name', 'Full name', 'text', true, '[]', 0),
    (f, 'department', 'Department', 'select', true, '["Engineering","Sales","Operations","Finance"]', 1),
    (f, 'start_date', 'Start date', 'date', true, '[]', 2),
    (f, 'manager_email', 'Manager email', 'text', true, '[]', 3),
    (f, 'needs_admin', 'Requires admin access', 'checkbox', false, '[]', 4),
    (f, 'notes', 'Additional notes', 'textarea', false, '[]', 5);
END $$;

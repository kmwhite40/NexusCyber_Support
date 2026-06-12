-- Canned responses (reusable reply templates, JSM parity). Global (organization_id NULL,
-- shared by all agents) or org-scoped. Bodies may contain {{placeholders}} rendered against
-- a ticket's context at insert time.
CREATE TABLE canned_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global
  name            text NOT NULL,
  body            text NOT NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE canned_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY canned_responses_isolation ON canned_responses
  USING (organization_id IS NULL OR organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON canned_responses TO nexus_app;

-- A few global starter templates (created_by NULL = system-provided).
INSERT INTO canned_responses (organization_id, name, body, tags) VALUES
  (NULL, 'Acknowledge — working on it',
   'Hi {{requester_name}}, thanks for reaching out about {{ticket_number}}. We''re looking into it now and will update you shortly.',
   ARRAY['ack']),
  (NULL, 'Need more info',
   'Hi {{requester_name}}, to help with {{ticket_number}} we need a bit more detail: when did this start, and does it affect other users? Thanks!',
   ARRAY['triage']),
  (NULL, 'Resolved — please confirm',
   'Hi {{requester_name}}, we believe {{ticket_number}} ("{{subject}}") is resolved. Please confirm everything''s working so we can close it out.',
   ARRAY['resolution']),
  (NULL, 'Password reset guidance',
   'Hi {{requester_name}}, you can self-service a password reset from the sign-in page via "Forgot password" (you''ll verify with MFA). If you''re still stuck, reply here.',
   ARRAY['accounts']);

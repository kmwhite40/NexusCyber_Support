-- CSAT becomes a three-question survey with a public, tokenized response link.
--
-- What was here already: one 1-5 score, created on ticket.resolved, answered only by signing in
-- to the portal. `token` was generated on every row and read by nothing — the invite linked to
-- /tickets/{id}, which an end user can only open after logging in. That is the reason response
-- rates are what they are; a survey you have to authenticate to answer is a survey most people
-- do not answer.
--
-- `score` KEEPS its meaning — overall satisfaction — so tickets.satisfaction_score, the csat
-- field in operationalKpis, and the per-agent avgRating in analytics.overview all go on working
-- untouched. The two new scores sit beside it rather than replacing it.
ALTER TABLE csat_surveys
  ADD COLUMN IF NOT EXISTS score_timeliness int CHECK (score_timeliness BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS score_technician int CHECK (score_technician BETWEEN 1 AND 5),
  -- The token is a credential: it answers a survey on the requester's behalf with no login. Only
  -- its SHA-256 lands here, so a database read — a backup, a support export, a compromised
  -- replica — yields no working links. The raw value exists exactly twice: in memory while the
  -- invite is composed, and in the recipient's mailbox.
  ADD COLUMN IF NOT EXISTS token_hash text,
  -- A link that works forever is a standing credential. Ratings also stop being useful long
  -- after the fact.
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  -- Who actually worked the ticket, stamped when the survey is created. tickets.assigned_agent_id
  -- is mutable and has no history table, so attributing CSAT to whoever holds the ticket TODAY
  -- credits (or blames) an agent for work they may never have touched — a reassignment months
  -- later silently rewrites past performance. This freezes the attribution at resolve time.
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES users(id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_csat_token_hash ON csat_surveys(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_csat_agent ON csat_surveys(agent_id) WHERE agent_id IS NOT NULL;

COMMENT ON COLUMN csat_surveys.score IS 'Overall satisfaction, 1-5. Unchanged meaning; mirrored to tickets.satisfaction_score.';
COMMENT ON COLUMN csat_surveys.token_hash IS 'SHA-256 of the public response token. The raw token is never stored.';
COMMENT ON COLUMN csat_surveys.agent_id IS 'Assignee at the moment the survey was created, frozen for durable attribution.';

-- Confluence-style knowledge base: spaces -> hierarchical pages -> immutable versions,
-- page comments, full-text search, and ticket-deflection logging (docs/nexus/07 §N).
-- Pages may be GLOBAL (organization_id NULL, authored by Nexus, visible to all customers)
-- or tenant-scoped. RLS permits reading NULL-org (global) rows; writes to global rows go
-- through the system context (Nexus authoring), mirroring the service-catalog pattern.

CREATE TABLE kb_spaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE kb_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global
  space_id        uuid NOT NULL REFERENCES kb_spaces(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES kb_pages(id) ON DELETE SET NULL,      -- page hierarchy
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',                              -- markdown
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version         int NOT NULL DEFAULT 1,
  labels          text[] NOT NULL DEFAULT '{}',
  author_id       uuid REFERENCES users(id),
  updated_by      uuid REFERENCES users(id),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  tsv             tsvector GENERATED ALWAYS AS
                    (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) STORED
);
CREATE INDEX ix_kb_pages_space ON kb_pages(space_id);
CREATE INDEX ix_kb_pages_parent ON kb_pages(parent_id);
CREATE INDEX ix_kb_pages_tsv ON kb_pages USING GIN(tsv);

CREATE TABLE kb_page_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  version     int NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  edited_by   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, version)
);

CREATE TABLE kb_page_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  page_id         uuid NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES users(id),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_kb_comments_page ON kb_page_comments(page_id);

CREATE TABLE kb_deflections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,
  query             text NOT NULL,
  suggested_page_ids uuid[] NOT NULL DEFAULT '{}',
  deflected         boolean NOT NULL DEFAULT false, -- user self-served instead of filing a ticket
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- RLS: reads see global (NULL-org) rows plus their own org; writes restricted to own org
-- (global authoring happens via the system context).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_spaces','kb_pages','kb_page_comments','kb_deflections']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_isolation ON %1$I
      USING (organization_id IS NULL OR organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
      WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_spaces, kb_pages, kb_page_versions, kb_page_comments, kb_deflections TO nexus_app;

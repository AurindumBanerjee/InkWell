-- Full-text search. Document bodies live in Yjs binary, so the server extracts plain text from the
-- live document and keeps it here, next to the title, with a weighted tsvector (title > body).
CREATE TABLE document_search (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  indexed_at  timestamptz NOT NULL DEFAULT now(),
  tsv         tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(body, '')), 'B')
              ) STORED
);
CREATE INDEX document_search_tsv_idx ON document_search USING gin (tsv);

-- Existing documents become title-searchable immediately; bodies are filled in as documents are
-- edited, or in bulk with `npm run reindex -w apps/server`.
INSERT INTO document_search (document_id, title)
SELECT id, title FROM documents WHERE deleted_at IS NULL;

-- Version history: full Yjs state plus the plain Markdown at that moment.
-- state lets us rebuild the exact CRDT; text_content powers previews, diffs and restore.
CREATE TABLE document_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('manual', 'auto', 'restore')),
  label        text CHECK (label IS NULL OR length(label) <= 200),
  state        bytea NOT NULL,
  text_content text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_versions_doc_idx ON document_versions (document_id, created_at DESC);

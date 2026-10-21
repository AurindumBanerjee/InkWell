-- Threaded comments. A root comment may be anchored to a text range; replies hang off a root.
-- Anchors are base64 Yjs RelativePositions, so they follow the text as it is edited concurrently.
-- quoted_text keeps what was selected, so the comment still makes sense if the anchor text is deleted.
CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES comments(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  anchor_start text CHECK (anchor_start IS NULL OR length(anchor_start) <= 400),
  anchor_end   text CHECK (anchor_end IS NULL OR length(anchor_end) <= 400),
  quoted_text  text CHECK (quoted_text IS NULL OR length(quoted_text) <= 500),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz,
  CHECK ((anchor_start IS NULL) = (anchor_end IS NULL)),
  CHECK (parent_id IS NULL OR (anchor_start IS NULL AND resolved_at IS NULL))
);
CREATE INDEX comments_doc_idx ON comments (document_id, created_at);
CREATE INDEX comments_parent_idx ON comments (parent_id);

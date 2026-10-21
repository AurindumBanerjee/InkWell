-- AI collaborator tables. Applied only when AI_FEATURES is on (see src/ai/index.ts), so the normal
-- version of the app never gets them.

-- A suggestion is a proposed change to a range of a document, never an edit. It stores the text
-- the model saw (base_text) and the change as hunks against that text, plus Yjs relative
-- positions of the range so it can follow the text while people keep editing.
CREATE TABLE ai_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  mode          text NOT NULL,
  status        text NOT NULL CHECK (status IN
                  ('working', 'pending', 'accepted', 'rejected', 'stale', 'failed', 'cancelled')),
  anchor_start  text NOT NULL,
  anchor_end    text NOT NULL,
  base_text     text NOT NULL DEFAULT '',
  proposed_text text,
  hunks         jsonb,
  sources       jsonb,
  tokens_used   integer NOT NULL DEFAULT 0,
  steps         integer NOT NULL DEFAULT 0,
  own_key       boolean NOT NULL DEFAULT false,
  error_code    text,
  -- Provider rate-limit numbers seen during the run (parsed headers, never keys), for the usage display.
  limits        jsonb,
  resolved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_suggestions_doc_idx ON ai_suggestions (document_id, created_at DESC);

-- Tokens spent per UTC day on the shared server key (own-key requests are not counted here).
CREATE TABLE ai_usage_daily (
  day      date PRIMARY KEY,
  tokens   bigint NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0
);

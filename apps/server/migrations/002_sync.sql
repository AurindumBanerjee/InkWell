-- CRDT persistence: an append-only log of Yjs updates plus a compacted snapshot.
-- State of a document = snapshot.state merged with every update whose id > snapshot.last_update_id.
CREATE TABLE document_updates (
  id           bigserial PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  update       bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_updates_doc_idx ON document_updates (document_id, id);

CREATE TABLE document_snapshots (
  document_id     uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state           bytea NOT NULL,
  last_update_id  bigint NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

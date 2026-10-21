# ADR 0006: Version history, comments and search

**Status:** accepted · **Date:** 2026-10-21

## Version history

- **What a version is:** the full Yjs state plus the Markdown text at that moment
  (`document_versions`). State lets us rebuild the exact CRDT; text powers previews and restore.
- **When they are taken:** on demand ("Save version"), and automatically when the last editor leaves
  a document whose text changed since its latest version (and that version is old enough). The check
  runs under a per-document advisory lock so several nodes closing the same room cannot both insert.
  Automatic versions are pruned to the newest 100; manual and restore versions are kept.
- **Restore is an ordinary edit, not a state swap.** We diff the current text against the old one
  (common prefix/suffix kept) and apply the difference to the live Yjs document. Connected editors
  converge without reconnecting, concurrent edits merge with the restore instead of being lost, and
  nothing is rewritten in history. A "before restore" version is saved first, so a restore can itself
  be undone. A property test checks the diff turns _any_ text into _any_ other text.
- **REST changes go through the room.** Restore and "save version" join the document's room through a
  server-side pseudo connection (`RoomManager.withRoom`), so they are broadcast, persisted and
  published to other nodes exactly like a client edit.
- **Trade-off:** storing whole states costs space (bounded by the pruning above). Deltas would be
  smaller but make restore and previews slower and more fragile.

## Comments

- **Storage in Postgres, not in the Yjs document.** Viewers must be able to comment but their CRDT
  writes are rejected by design (ADR 0003), and comments should be queryable and deletable without
  touching the document's history. Anyone who can view a document can comment; only authors edit their
  own comments; authors or owners delete; editors or the thread author resolve.
- **Anchors are Yjs relative positions** (base64), so a comment stays attached to its text while
  others edit around it, including offline edits that merge later. The selected text is stored too,
  so the comment still reads sensibly if the anchored text is deleted. The server only checks that an
  anchor is canonical base64 and round-trips as a relative position; it does not interpret it.
- **Liveness:** the server pings connected clients ("comments changed", application message type 10,
  outside y-websocket's reserved 0-3) and across nodes via the bus; clients refetch. The ping carries
  no data, so there is nothing to leak and nothing to keep consistent. Clients also refetch on every
  reconnect, because pings sent while offline are gone.

## Search

- **Postgres full-text search**, not an external engine: one fewer service, transactional with the
  rest of the data, and enough for this scale. A generated, weighted `tsvector` (title weight A, body
  weight B) with a GIN index; `websearch_to_tsquery` gives phrases, `-exclusion` and `or` for free.
- **Document bodies are extracted from the live Yjs document** and stored next to the title.
  Re-indexing is throttled while editing (2 s after persisted updates) and immediate when a room
  closes, so the final text is searchable the moment the last editor leaves. `npm run reindex`
  rebuilds everything from persisted CRDT state.
- **Authorization is inside the SQL.** A document the caller cannot open can never contribute a row,
  a rank or a snippet. Tests cover members, direct shares, revoked shares and soft-deleted documents.
- **Snippets use control-character markers**, not HTML, so user-authored text can never inject markup
  into results.
- **Measured, then tuned** (`bench/search-bench.ts`, `bench/search-lab.ts`): the lab compares query
  formulations and refuses to time one that does not return identical ordered results. The chosen
  shape ranks and access-filters first and builds snippets only for the requested page. Forcing the
  index to run first was measurably worse for common terms (367 ms vs 129 ms median), so the planner
  chooses. An earlier benchmark that analysed only one table produced misleading plans; the corpus
  loader now analyses the whole database.

## Known limits

- Ranking cost grows with the number of _matching, visible_ documents, so queries made of very common
  words are the slowest case (see README results). Mitigations if it matters: require a second term,
  cap ranked candidates, or add a trigram/prefix index for typeahead.
- Search results can lag edits by up to the indexing interval while a document is open.
- Comment pings are best-effort hints; the source of truth is always a refetch.

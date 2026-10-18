# ADR 0003: Yjs CRDT over WebSocket, append-only update log + snapshots

**Status:** accepted · **Date:** 2026-10-18

## CRDT vs OT

Inkwell uses **Yjs (a CRDT)** rather than operational transformation.

|                     | OT (Google Docs-style)                                        | CRDT (Yjs)                                                           |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Server role         | Must serialise and transform every op; single source of order | Relays and stores opaque updates; no transform logic                 |
| Offline / reconnect | Hard: long divergent histories need careful transformation    | Natural: updates commute, so merge order doesn't matter              |
| Horizontal scaling  | Per-document total order forces a single owner per doc        | Any server can accept any update; Redis fan-out suffices (M3)        |
| Cost                | Small documents                                               | Metadata grows (tombstones, client ids); mitigated by GC + snapshots |

A hand-rolled RGA is a possible later stretch goal; Yjs gives a battle-tested implementation and the
y-websocket protocol, so effort goes into the system around it.

## Wire protocol

Standard y-websocket framing (`0` = sync step1/step2/update, `1` = awareness) so the stock client works.
Route: `GET /ws/docs/:id`, authenticated by the session cookie on the upgrade request.

- **Origin** must equal `WEB_ORIGIN` when present (blocks cross-site WebSocket hijacking).
- **Close codes**: 4401 unauthenticated, 4403 forbidden/revoked, 4404 not found, 4400 malformed. Clients
  treat 44xx as terminal and do not reconnect.
- **Role enforcement is on the server**: viewers get the full handshake and live updates, but their
  `step2`/`update` messages are dropped. They are not disconnected (the UI is read-only anyway; a
  modified client simply has no effect). Roles are re-checked every `reauthMs` (15 s default), so a
  revoked share closes the socket and a downgrade stops writes within one interval.

## Persistence

State of a document = `document_snapshots.state` merged with `document_updates` rows newer than
`last_update_id`.

- Incoming updates are **batched** per room for `flushMs` (100 ms) and merged with `Y.mergeUpdates`
  into one row. Trade-off: a crash can lose up to ~100 ms of edits that were already broadcast to peers
  (they re-send them on reconnect, because clients keep their full state, so in practice they heal).
- **Compaction** folds the log into the snapshot when `compactEvery` rows accumulate, every 30 s while
  dirty, and when the last client leaves. It operates only on persisted bytes under a
  per-document `pg_advisory_xact_lock`, so it is safe with several server processes (M3).
- The room is evicted when its last connection closes, after flush + compaction.

## Known limitations

- Awareness (cursor/name/colour) is client-asserted; a malicious editor could spoof another user's
  presence label. Server-stamped identity is a follow-up.
- No per-document size cap yet.
- Version history (M4) will add a `document_versions` table alongside snapshots.

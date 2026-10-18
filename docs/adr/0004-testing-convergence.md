# ADR 0004: How convergence is tested

**Status:** accepted · **Date:** 2026-10-18

## Problem

"It worked when I typed in two tabs" is not evidence of convergence. Bugs hide in orderings:
a message delivered late, a client dropping mid-handshake, an update compacted while another
arrives.

## Decision: three layers

1. **Pure Yjs property** (`test/convergence.test.ts`): fully partitioned replicas edit, then every update
   is applied to fresh replicas in shuffled order with duplicates, and also via `Y.mergeUpdates` (the
   function compaction relies on). All results must be equal. This guards our assumption that
   update application is order-independent and idempotent.
2. **Server-room property**: fast-check generates sequences of edits, message deliveries (any queue,
   any order), disconnects and reconnects for 2–3 clients attached to a real `Room` backed by Postgres.
   After healing the partition and draining the network, every client, the server doc, **and the state
   reloaded from the database after flush + compaction** must be identical. This exercises the actual
   relay, handshake-on-reconnect and persistence code.
3. **Browser end-to-end** (Playwright): two real browser contexts type simultaneously into the same
   empty document; offline edits on one side merge with online edits on the other; a viewer cannot
   change the document; content survives everyone leaving.

## Consequences

- The model clients speak the real protocol but use in-memory queues, so they test our logic, not TCP.
  Layer 3 and `sync.test.ts` (real sockets) cover the transport.
- Property tests are randomised; failures print a shrunk counterexample and seed to reproduce.

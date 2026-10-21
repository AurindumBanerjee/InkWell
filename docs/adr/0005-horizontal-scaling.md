# ADR 0005: Horizontal scaling: Redis pub/sub fan-out with document-affinity routing

**Status:** accepted · **Date:** 2026-10-21

## Problem

A sync room (the in-memory Yjs doc plus its connections) lives in one process. To run several nodes,
editors of the same document connected to different nodes must still see each other's edits and
cursors, and the system must survive a node disappearing.

## Decision

1. **Redis pub/sub as a per-document bus** (`inkwell:doc:<id>`). A room subscribes while it has at
   least one local client. Local edits are published as opaque Yjs updates, presence as awareness
   updates. Nodes ignore their own echoes (`serverId`) and never re-publish what came from the bus.
2. **Document-affinity ("sticky") routing at the proxy**: `hash $uri consistent` on `/ws/docs/<id>`,
   so every client of a document normally lands on the same node. REST is round-robin because
   sessions live in Postgres.
3. **Resync instead of reliable delivery.** Pub/sub is at-most-once. Rather than building a durable
   log, a room sends `SYNC1` (its state vector) when it starts hosting a document and whenever the
   Redis connection recovers; peers answer with the missing diff and their clients' presence.
4. **Postgres stays the source of truth.** The node that receives an edit from a client persists it;
   updates arriving from the bus are applied but not written again (no double writes).

## Why not the alternatives

| Alternative                                     | Why not                                                                                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Affinity routing only, no Redis                 | Fine until the ring changes: during a node loss or deploy, one document can have clients on two nodes with no way to see each other. Redis makes that case correct instead of silently split. |
| Redis fan-out only, no affinity                 | Correct but wasteful: with N nodes hosting a document every edit costs N-1 publishes and N rooms hold the same state. Affinity makes the steady state one room, zero cross-node traffic.      |
| Sticky by client IP / cookie                    | Balances clients, not documents: collaborators on one document get scattered across nodes, which maximises cross-node traffic.                                                                |
| Redis Streams / a durable ordered log           | Heavier operationally. Unnecessary: CRDT updates commute, so loss is repaired by state-vector resync and Postgres already provides durability.                                                |
| Operational Transform with a per-document owner | Needs a single total order per document, so failover has to hand the order over exactly. CRDTs avoid that (ADR 0003).                                                                         |

## Consistency vs latency

- **Latency:** local edits are applied and broadcast to same-node clients immediately; other nodes
  get them after one Redis hop. Nothing waits for Postgres or for a quorum.
- **Consistency:** eventual. Any two rooms converge once they have exchanged all updates, in any
  order, any number of times. The tests drop every bus message for a while and verify convergence.
- **Authorization is not eventual:** roles are enforced on the node the client connects to, from
  Postgres, and re-checked periodically, so a revoked share is cut within `reauthMs` on every node.

## Failure modes

| Event                                    | Behaviour                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node killed                              | nginx re-hashes its documents to survivors; clients reconnect (y-websocket backs off) and re-handshake from their local state. Presence of its clients expires on other nodes after 30 s (awareness timeout). Edits not yet flushed (≤ `flushMs`) were already published, so peers hold them. |
| Redis down                               | Each node keeps serving its own clients; cross-node edits stop flowing. On recovery every room resyncs and the divergence heals.                                                                                                                                                              |
| Redis restart / message loss             | Same as above: `onReconnect` triggers `resync()`.                                                                                                                                                                                                                                             |
| Two nodes persist the same edit          | Cannot happen: only the node that received it from a client writes it.                                                                                                                                                                                                                        |
| Node crashes within `flushMs` of an edit | The edit may be absent from Postgres, but clients keep full local state (IndexedDB) and re-send it on reconnect.                                                                                                                                                                              |

## Consequences / limits

- A document is still bounded by one node's memory per room, and presence relays scale with
  editors per document.

## Measured (milestone 5, see bench/README.md)

Same 1,000-editor workload (100 documents × 10 editors, ~500 edits/s, ~4,500 deliveries/s; 3 nodes
at 0.5 CPU), one run per variant:

|                               | Affinity (this ADR) | Round-robin        |
| ----------------------------- | ------------------- | ------------------ |
| Sync latency p50 / p95 / p99  | 2 / 4 / 8 ms        | 3 / 15 / 69 ms     |
| Sync node peak CPU (cap ~50%) | 28–36%              | 49–50% (saturated) |
| Postgres peak CPU             | 79%                 | 194%               |

Affinity is not only a Redis saving: without it every node hosts most documents, so loading,
re-indexing and re-authorising are multiplied by the node count, and the nodes saturate first.
Redis stayed light in both cases (12% / 17% of a core), so it is not the constraint at this scale.

- Awareness that a node merely stops hearing about is expired locally and deliberately **not**
  published, so a node that missed heartbeats cannot evict a client that is alive elsewhere.

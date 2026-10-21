# Benchmarks

Everything here is reproducible and every number quoted in the main README comes from a file in
[results/](results). Treat the numbers as measurements of _this_ setup, not as capacity claims.

| What                | Script                             | Raw results                                |
| ------------------- | ---------------------------------- | ------------------------------------------ |
| Real-time sync load | [load.sh](load.sh) + [k6/](k6)     | `results/k6-*.json`, `results/stats-*.txt` |
| Search latency      | [search-bench.ts](search-bench.ts) | `results/search-20000.json`                |
| Search query lab    | [search-lab.ts](search-lab.ts)     | `results/search-lab-20000.json`            |

## Sync load test (k6)

```bash
# needs Docker; the first scenario is a smoke test and the rest are skipped if it moves no traffic
SCENARIOS="smoke:20:5s:15s:4 editors-1000:1000:60s:120s:10" bench/load.sh
# the same 1,000 editors without document-affinity routing:
NGINX_CONF=nginx.roundrobin.conf SCENARIOS="smoke:20:5s:15s:4 rr:1000:60s:120s:10" bench/load.sh
```

Scenario format: `name:editors:ramp:hold[:editors-per-document]`. The script builds nothing it does
not need, brings up the 3-node cluster, seeds the data, runs each scenario, samples container CPU
and memory every 8 s, and tears everything down.

### Setup

- **Hardware:** Intel Core i5-1240P (16 logical cores), 63.7 GiB RAM, Windows 11, Docker Desktop.
  The machine is shared with other jobs, so absolute numbers carry noise.
- **Cluster** ([docker-compose.cluster.yml](../docker-compose.cluster.yml)): nginx, three sync nodes
  (Node 22, **0.5 CPU each**), Postgres 17, Redis 7, all on one Docker network.
- **Load generator:** k6 in a container, **4 CPUs**, on the same network. Total budget under 8 of
  16 cores.
- **Workload:** N editors over N/10 documents (10 editors share a document). Each editor holds one
  WebSocket and types a small marker into its document **on average once every 2 s** (jittered
  0.5–1.5×). At 1,000 editors that is about 500 edits/s and 4,500 deliveries/s. One session cookie is
  shared by all virtual users; per-connection auth cost is the same as for distinct users.
- **What "sync latency" means:** the marker carries the sender's clock; a receiver computes
  `now - marker` when the frame arrives. One-way, sender to receiver, through nginx, a sync node
  (and Redis when the two are on different nodes). Both ends are k6 virtual users on one clock, so it
  includes some generator scheduling noise: read it as an upper bound.

### Why the clients are "lite", and how invalid runs are caught

A first version kept a full Yjs replica per virtual user. At 1,000 editors that saturated k6 itself
(it hit 100% then 99% of its CPU cap), so the latencies it printed measured the load generator
falling behind, not the server. The scenario now uses lite clients: they send real Yjs updates and
complete the handshake like any client, but scan live update frames for the marker in the raw bytes
and keep no replica. The server does exactly the same work either way (accept, apply, persist, fan
out); only the generator is cheaper.

`load.sh` samples the k6 container too and prints **GENERATOR SATURATED** (and the run's latencies
must not be used) if it exceeds 80% of its CPU cap. Other measurement details:

- Markers that arrive in the initial state transfer are history, typed before the receiver joined,
  and are skipped; counting them reports the document's age as latency (an earlier run did this).
- Each virtual user gets a unique Yjs client id (random ids collided across VUs).
- A receiver clock reading slightly behind the sender's (the Docker VM clock can step) produces a
  negative latency; those samples are dropped and counted (`clock anomalies dropped`).

### Results

All scenarios below passed the generator check (k6 peak CPU in the last column) and had **0
unexpected closes and 0 WebSocket errors**.

| Editors | Documents | Sync latency p50 / p95 / p99 / max (ms) | Edits sent | Frames delivered | k6 peak CPU (cap 400%) |
| ------: | --------: | --------------------------------------- | ---------: | ---------------: | ---------------------: |
|      20 |         5 | 3 / 5 / 8.2 / 47                        |        320 |              881 |                     9% |
|     250 |        25 | 2 / 5 / 17 / 183                        |     11,159 |           92,772 |                    49% |
|     500 |        50 | 2 / 5 / 9 / 200                         |     31,526 |          262,256 |                    85% |
|   1,000 |       100 | **2 / 4 / 8 / 235**                     |     81,868 |          681,464 |                   237% |

Peak container CPU at 1,000 editors (docker stats, percent of one core; a 0.5-CPU node tops out at
about 50%): sync nodes 28–36%, Postgres 79%, Redis 12%, nginx 23%.

**What document-affinity routing buys** (same 1,000-editor scenario, same work: 81.9k edits, 681k
deliveries; one run per variant):

|                                         | Affinity (hash by document) | Round-robin         |
| --------------------------------------- | --------------------------- | ------------------- |
| Sync latency p50 / p95 / p99 / max (ms) | 2 / 4 / 8 / 235             | 3 / 15 / 69 / 503   |
| Sync node peak CPU (cap ~50%)           | 28–36%                      | 49–50% (at the cap) |
| Postgres peak CPU                       | 79%                         | 194%                |
| Redis peak CPU                          | 12%                         | 17%                 |

Without affinity each document's editors are split over three nodes, so every node hosts (and loads,
indexes and re-authorises) most documents and a large share of deliveries crosses Redis. The nodes
saturate, tail latency grows several-fold, and Postgres does about 2.5× the work.

### Caveats, plainly

- One run per configuration: no confidence intervals. Differences of a few milliseconds at p50 are
  noise; the affinity comparison (several-fold at the tail, nodes at their CPU cap) is not.
- Lite clients do not exercise the browser path (CodeMirror, IndexedDB, rendering).
- A single shared session; one machine; Docker Desktop networking adds hops that a real deployment
  would not have, and the host is shared with other jobs.
- Editing rate is a modelling choice. At one edit per user per second (about 900 edits/s) the
  generator saturated before the server did, so no valid latency was obtained at that rate on this
  machine. In that run the sync nodes were already at or near their CPU caps and Postgres peaked at 189%.
- The next scaling limit looks like the Postgres write path (persisting each active room every
  100 ms, search re-indexing, periodic access re-checks), not the sync tier.

## Search benchmarks

See the main README and [ADR 0006](../docs/adr/0006-history-comments-search.md). `search-lab.ts`
refuses to time a query variant unless it returns exactly the same ordered results as the baseline.

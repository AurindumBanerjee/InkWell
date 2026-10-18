# Inkwell

A real-time collaborative Markdown editor (a minimal Google Docs) with workspaces, role-based sharing, and CRDT sync.

> **Status: Milestone 1 of 7 — auth, workspaces, documents and sharing (API).** Real-time sync, scaling, search, deployment and user metrics are not built yet; sections below say so rather than imply otherwise.

## Architecture

```mermaid
flowchart LR
  Browser["Next.js client (planned M1b)"] -->|HTTPS + session cookie| API["Fastify API (apps/server)"]
  API --> PG[("Postgres: users, sessions, workspaces, documents, shares")]
  Browser -. "WebSocket + Yjs (M2)" .-> WS["Sync servers (M2/M3)"]
  WS -. "pub/sub (M3)" .-> Redis[("Redis")]
  WS -. "snapshots (M2)" .-> PG
```

Dashed edges are planned. Design decisions live in [docs/adr](docs/adr).

## Quickstart

```bash
git clone https://github.com/<you>/InkWell && cd InkWell
npm install
cp .env.example .env && docker compose up -d postgres   # Postgres on :5432
npm run migrate -w apps/server && npm run dev -w apps/server
curl -s localhost:4000/healthz                          # {"ok":true}
```

Run the tests with `npm test` — no setup needed locally (it boots an embedded Postgres). Dev sign-in:
`curl -c jar -H 'content-type: application/json' -d '{"email":"me@example.com"}' localhost:4000/auth/dev-login`.
Dev login only works from localhost (and never in production).

### GitHub sign-in (manual test checklist)

Register an OAuth app at GitHub → Settings → Developer settings → OAuth Apps. Homepage URL
`http://localhost:3000`; **callback URL `http://localhost:4000/auth/github/callback`** (the API
handles the callback, then redirects to the web app). Put the id/secret in `.env`; never commit it.

- [ ] Open `http://localhost:4000/auth/github` → GitHub consent page appears
- [ ] Approve → redirected to `WEB_ORIGIN`, `GET /me` returns your GitHub profile
- [ ] `GET /workspaces` shows a personal workspace with role `owner`
- [ ] `POST /auth/logout`, then `GET /me` returns 401

## Results

| Milestone | Measured                                               | Environment                                    |
| --------- | ------------------------------------------------------ | ---------------------------------------------- |
| M1        | 26 tests passing, 89.9% line coverage (`src/`)         | Node 20.16, embedded Postgres 18.4, Windows 11 |
| M5        | _p95 sync latency at 1,000 editors — not measured yet_ | —                                              |

Benchmarks will live in [bench/](bench) with the hardware and dataset used.

## Trade-offs (to be expanded as M2–M3 land)

- **CRDT vs OT:** planned choice is Yjs (CRDT) — no central transform server, offline edits merge by construction, at the cost of metadata growth and tombstones. Full ADR in M2.
- **Consistency vs latency:** CRDTs give eventual consistency with local-first latency; permission changes (checked server-side) are the one place we need strong consistency.

## Limitations

- No UI yet; the API is exercised through tests and `curl`.
- Users can only be shared with after signing in once (no email invites or public links).
- Live GitHub OAuth HTTP calls are not covered by automated tests (only the flow via a fake provider).
- Migrations are forward-only.

## What I'd do next

M1b Next.js UI → M2 Yjs sync + presence + snapshots → M3 Redis-coordinated WebSocket scaling.

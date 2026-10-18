# ADR 0001: npm-workspaces monorepo, Fastify, plain SQL migrations

**Status:** accepted · **Date:** 2026-10-18

## Context

Inkwell needs an HTTP API (auth, workspaces, documents) and, from milestone 2, a WebSocket sync
server that shares auth and permission logic with it.

## Decision

- **Monorepo (npm workspaces)**: `apps/server` now, `apps/web` next. One lockfile, one CI.
- **Fastify + TypeScript** for the API. The WebSocket server will live in the same process/package so
  the sync path reuses `loadDocument` / `effectiveRole` rather than re-implementing authorization.
  Fastify gives schema-friendly routing and `inject()` for fast in-process HTTP tests.
- **Zod** validates both config (fail fast at boot) and request bodies.
- **Plain `.sql` migrations** with a ~40-line runner (`schema_migrations` table, one transaction per
  file, advisory lock so replicas booting together don't race). An ORM/migration framework would add
  weight without helping: the interesting queries (tsvector search, snapshot compaction) are raw SQL anyway.
- **Tests run against a real Postgres** (embedded locally, a service container in CI). Mocking the
  database would hide exactly the bugs that matter here (constraints, ON CONFLICT, role joins).

## Consequences

Down-migrations are not supported; rollbacks are forward-fix migrations. Acceptable for this scale.

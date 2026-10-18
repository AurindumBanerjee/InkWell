# ADR 0002: Server-side sessions, GitHub OAuth, workspace + per-document roles

**Status:** accepted · **Date:** 2026-10-18

## Decisions

- **Opaque server-side sessions, not JWTs.** A 256-bit random token lives in an `HttpOnly`,
  `SameSite=Lax` cookie; Postgres stores only its SHA-256, so a DB leak does not yield usable
  sessions. Logout and revocation are a row delete. A JWT would make revocation hard, and we need
  a DB lookup for permissions anyway.
- **CSRF**: `SameSite=Lax` plus an `Origin` allow-list check on all non-GET requests.
- **OAuth via a thin `OAuthProvider` interface** (GitHub implemented by hand with `fetch`, ~40 lines).
  The interface lets tests drive the full callback flow with a fake provider. State is a random
  value in a short-lived cookie, compared on callback. Accounts link on **verified** primary email only.
- **Dev login** (`ENABLE_DEV_LOGIN`) exists for local work and tests; `loadConfig` throws if it is on
  in production.
- **Roles**: workspace membership (`owner|editor|viewer`) and optional per-document shares
  (`editor|viewer`). Effective role = the higher of the two. Only owners manage members/shares and
  delete. Inaccessible documents return **404, not 403**, so ids can't be probed for existence.
- **Soft delete** for documents (`deleted_at`); version history (M4) and restore depend on it.

## Not done (deliberately)

Link-based public sharing and email invites: invitees must sign in once before being shared with.
Revisit when real users ask.

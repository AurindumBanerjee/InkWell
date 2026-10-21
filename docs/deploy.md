# Deploying Inkwell

Inkwell ships as two versions of one codebase ([ADR 0007](adr/0007-ai-feature-flag.md)): the
**normal** version and the **AI** version. Each is a separate _instance_ (its own containers,
database, OAuth app and address). This runbook stands up the normal instance and describes how to
stand up the second one. **Nothing here has been run against a hosting provider**: no accounts,
secrets or public addresses exist yet, and creating them needs the owner's explicit yes.

## What an instance is

One host, one sync node, no Redis (the in-process bus is enough for a single node):

```
public address (TLS terminates in front)
        │
      nginx  ── /api/*  → server (API, prefix stripped)
        │    ── /ws/*   → server (document sync; /ws/ai in the AI version)
        │    ── /*      → web (Next.js)
     postgres (this instance's own database)
```

Everything that differs between instances comes from one env file:
`deploy/instances/<name>.env` (git-ignored; commit only the `*.env.example` templates).

| Varies per instance            | Variable                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| name (compose project, images) | `INSTANCE`                                                              |
| host port                      | `HTTP_PORT`                                                             |
| public address                 | `WEB_ORIGIN`, `PUBLIC_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` |
| database                       | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`                     |
| feature flags                  | `AI_FEATURES`, `NEXT_PUBLIC_AI_FEATURES`                                |
| sign-in                        | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (an OAuth app per instance)  |
| AI keys (AI instance only)     | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `SEARCH_API_KEY`            |
| error tracking (optional)      | `SENTRY_DSN`                                                            |

## Normal instance

1. Decide the public address and create a GitHub OAuth app with callback
   `<PUBLIC_URL>/auth/github/callback` (for example `https://inkwell.example.com/api/auth/github/callback`).
2. `cp deploy/instances/normal.env.example deploy/instances/normal.env` and fill it in. Use a
   password of 16+ URL-safe characters. Never commit the copy.
3. `node deploy/check-instance.mjs deploy/instances/normal.env` must print `ok`. It checks that the
   two AI flags agree and are `false`, that no AI key is present, that the four URLs derive from one
   origin, and that secrets are not placeholders.
4. Build and start:
   ```bash
   docker compose --env-file deploy/instances/normal.env -f deploy/docker-compose.prod.yml up -d --build
   ```
5. Verify: `curl -fsS http://localhost:8080/api/healthz` returns `{"ok":true,...}`; the home page
   loads; GitHub sign-in completes; two browsers editing one document see each other.
6. Point the platform's TLS terminator at `HTTP_PORT`. Cookies are `Secure` in production, so use
   HTTPS (browsers also accept `http://localhost`).

Updating: `git pull`, then rerun step 4. Migrations run on server start under an advisory lock.

## Second instance (the AI version): how, not done

Do this only once the owner has agreed to each external thing it needs.

1. **Needs the owner's yes first:** a second public address; a second GitHub OAuth app; a Groq API
   key (and a search-provider key for the Expand mode); any paid hosting.
2. `cp deploy/instances/ai.env.example deploy/instances/ai.env`. Use a different `INSTANCE`,
   `HTTP_PORT`, public address and `POSTGRES_DB` from the normal instance, set both flags to `true`,
   and fill in the keys. Never commit it.
3. `node deploy/check-instance.mjs deploy/instances/ai.env` must print `ok`.
4. `docker compose --env-file deploy/instances/ai.env -f deploy/docker-compose.prod.yml up -d --build`
   The project name `inkwell-ai` keeps it fully separate from `inkwell-normal`; it builds its own web
   image (`inkwell-web:ai`) because the web flag is compiled in.
5. Verify the flag took effect: `GET /api/ai/status` returns 200 when signed in (it is a 404 on the
   normal instance), and the document page has an **AI** button.

To share one Postgres between instances instead of one container each, remove the `postgres`
service from the compose file, point `DATABASE_URL` at the shared server and give each instance its
own database name. Never share a database name.

## Monitoring

- **Uptime:** `GET /api/healthz` is unauthenticated and cheap (`{"ok":true,"node":...,"rooms":N,"conns":N}`,
  no document ids). Point any external uptime checker at it. Choosing and registering one is the
  owner's decision.
- **Errors:** set `SENTRY_DSN` to turn error tracking on; unset means off. Not yet wired in this
  version of the code.
- **Logs:** the server never logs request bodies, cookies or provider keys.

## Backups

The instance's data is its Postgres volume (`pgdata`). Back it up with
`docker compose ... exec postgres pg_dump -U <user> <db> > backup.sql`; restore with `psql`. A restore
test has not been run.

## What is not done

No provider has been chosen, nothing is deployed, CD is not wired (CI builds and validates the
images and the compose files on every change but does not publish them), Sentry is not integrated
and no uptime checker is registered.

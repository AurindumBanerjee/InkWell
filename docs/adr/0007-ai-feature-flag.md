# ADR 0007: One codebase, two deployable versions behind a feature flag

**Status:** accepted · **Date:** 2026-10-21

## Context

Inkwell is a collaborative Markdown editor. An AI collaborator (an agent that joins a document as a
peer and proposes edits) is a separate product decision with different risks: it spends money, calls
third-party services and puts untrusted text in front of a model. The normal editor must stay exactly
as it is, and the two versions should not drift into two codebases.

## Decision

**One codebase, two builds, one decision made in two places.**

|         | Server                      | Web                                                |
| ------- | --------------------------- | -------------------------------------------------- |
| Flag    | `AI_FEATURES` (runtime env) | `NEXT_PUBLIC_AI_FEATURES` (build arg, compiled in) |
| Default | `false`                     | `false`                                            |

With the flag **off**:

- **Server:** `app.ts` imports `src/ai/` with a dynamic `import()` only when the flag is on. The AI
  module is never loaded, so its routes (`/ai/*`) and its WebSocket handler (`/ws/ai`) are not
  registered and return **404**, and nothing in it can run. All AI environment variables (`LLM_*`,
  `SEARCH_API_KEY`) are read **only inside that module**, so with the flag off no key is read.
- **Web:** the AI UI is imported with `process.env.NEXT_PUBLIC_AI_FEATURES === 'true' ? dynamic(() =>
import(...)) : null`, written inline at the point of use. Next replaces the variable with a literal
  at build time, so the bundler removes the branch and the AI chunk is **not shipped**; hiding a
  component with CSS or a runtime check would still send the code to every visitor.

All AI code lives behind this seam: `apps/server/src/ai/` and `apps/web/app/doc/[id]/ai/`. The normal
path (sync, persistence, comments, search) has no AI branches; the AI version adds routes and UI on
top of the same core.

## Why a flag rather than two repositories or a plugin system

- Two repositories double every fix to sync, auth and persistence, which are the hard parts.
- A runtime plugin system is more machinery than one seam needs.
- A build-time flag on the web plus a load-time flag on the server is simple, testable, and fails
  safe: forgetting to set either leaves the normal version.

## Making the flag trustworthy

A flag only protects if it is tested from both sides:

- `ai-flag-off.test.ts` replaces the AI module with one that **throws if loaded**, then asserts that
  AI HTTP routes and the AI WebSocket return 404 even for a signed-in user, that config loading and
  app start-up never **read** any AI variable (the environment is a recording proxy), and that
  ambiguous flag values (`yes`, `1`) are rejected instead of guessed.
- `ai-flag-on.test.ts` asserts the routes exist, require a session, report whether keys exist but
  never their values, and that the secrets holder cannot leak through `JSON.stringify`,
  `util.inspect` or logging.
- `deploy/assert-ai-bundle.mjs` scans the built web output: the normal build must contain none of the
  AI UI, the AI build must contain it. A Playwright spec checks the same in a real browser.
- CI runs the whole server suite, the web build assertion and the whole end-to-end suite with the flag
  **off and on**. The LLM is never contacted; CI holds no provider keys.
- `deploy/check-instance.mjs` refuses an instance whose two flags disagree (a half-enabled instance),
  or whose normal-version config holds an AI key.

## Deploying two instances

Each version is its own instance: its own containers, database, OAuth app, public address and web
image (the web flag is compiled in, so the image differs). `deploy/docker-compose.prod.yml` is
parameterised by an instance env file (`deploy/instances/normal.env`, `ai.env`); the compose project
name is derived from the instance name, so two instances never share containers, networks or
volumes. See `docs/deploy.md`.

## Consequences

- The AI instance's extra risks (cost, abuse, SSRF through a web tool) exist only there; the normal
  instance holds no AI key and exposes no AI route.
- The flag is a deployment decision, not a per-user toggle: users of the normal instance cannot
  turn AI on, and there is no code path that does.
- Slightly more CI: every job runs twice. This is deliberate; it is what stops the normal version
  from silently depending on AI code.

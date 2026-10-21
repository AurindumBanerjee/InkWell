# ADR 0008: AI suggestions, anchoring and stale detection

**Status:** accepted (on the `ai-collab` branch; not part of the normal version) · **Date:** 2026-10-21

## Decision

The AI collaborator **never edits a document**. It produces a _suggestion_: the text the model saw
(`base_text`), a list of hunks against that text, and Yjs relative positions marking the range.
A person with the editor role accepts or rejects it.

### Why hunks against a stored base, not "the new text"

While the model works (seconds, or tens of seconds for web research) people keep typing. If a
suggestion were "replace the range with this text", accepting it would silently erase their edits.
With hunks against the base text we can re-base the model's change onto the text as it is _now_.

### Anchoring

- Positions are **Yjs relative positions**, which name the character they sit next to and so follow
  the text through concurrent and late-arriving edits. The range start sticks to the character after
  it, the end to the character before it, so text typed exactly at either edge falls outside the range.
- The server re-derives its own anchors from the live document when a request arrives; it never
  trusts character offsets from a browser.

### Accepting (`planApply` then `commitApply`)

1. Re-resolve the anchors. If either no longer resolves, the suggestion is **stale**.
2. Take the text now inside the range and diff it against `base_text` to find what people changed.
3. Re-base each AI hunk onto the current text. A hunk that overlaps a human edit, two insertions at
   the same point, or a range people changed by more than half, make the suggestion **stale**.
   Edits that merely touch are independent. Nothing is ever guessed.
4. Otherwise record a safety version ("Before AI suggestion"), then apply the hunks in **one Yjs
   transaction**, touching only the characters the hunks cover, so concurrent edits elsewhere merge
   normally. A property test checks this equals applying both change sets to the base.

Stale suggestions are also detected when the list is read, without anyone clicking Accept.

### The agent as a peer

While a run is in progress the agent joins the document room through its own connection and
publishes an awareness state named "AI assistant" with a cursor over its range. Editors render it
like another person's cursor. The entry belongs to that connection, so it disappears with it.

## Safeguards (summary)

Server-side editor-role check; optional invite list; per-user rate limit and one running request per
user; per-request token and step budgets; a global daily token budget (persisted) that switches the
shared key off cleanly; a user's own key held for one request only, never stored, logged or returned;
SSRF-safe fetching; fetched text wrapped as untrusted data; the model can only call three fixed tools,
may only read URLs that search returned, and its output is stripped of links, images and HTML (the
server writes the source links).

## Limits

- The suggestion is shown in a side panel, not as inline decorations inside the editor.
- Events are delivered in-process, so the AI version is single-node.
- Stale detection is conservative on purpose: some suggestions that could be merged are refused.
- Expand quality depends on the model and search results; every claim is tied to a URL the run saw,
  but that does not prove the page supports the claim.

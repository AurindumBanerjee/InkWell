import type { Completion, CompletionRequest, LlmClient } from '../../src/ai/llm.js';
import type { FetchedPage } from '../../src/ai/web/safeFetch.js';
import type { SearchClient, SearchResult } from '../../src/ai/web/search.js';

export type LlmReply = string | { text: string; tokens?: number; headers?: Record<string, string> };

/** A scripted model: no network, every request recorded for assertions. */
export class FakeLlm implements LlmClient {
  readonly calls: (CompletionRequest & { n: number })[] = [];
  probes: (string | undefined)[] = [];
  serverKeyConfigured = true;
  probeHeaders: Record<string, string> = {};
  probeError: Error | null = null;

  constructor(
    private readonly handler: (req: CompletionRequest, n: number) => LlmReply | Promise<LlmReply>,
  ) {}

  async complete(req: CompletionRequest): Promise<Completion> {
    const n = this.calls.length;
    // A snapshot: the agent keeps appending to its own messages array after the call.
    this.calls.push({ ...req, messages: req.messages.map((m) => ({ ...m })), n });
    const reply = await this.handler(req, n);
    const r = typeof reply === 'string' ? { text: reply } : reply;
    const tokens = r.tokens ?? 100;
    return {
      text: r.text,
      usage: {
        promptTokens: Math.floor(tokens * 0.7),
        completionTokens: Math.ceil(tokens * 0.3),
        totalTokens: tokens,
      },
      headers: r.headers ?? {},
    };
  }

  async probe(apiKey?: string): Promise<Record<string, string>> {
    this.probes.push(apiKey);
    if (this.probeError) throw this.probeError;
    return this.probeHeaders;
  }
}

/** The text of the <document> block in the last user message. */
export function documentOf(req: CompletionRequest): string {
  const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const m = /<document>\n([\s\S]*?)\n<\/document>/.exec(user);
  return m?.[1] ?? '';
}

/** A rewrite model that applies `fn` to the document text it was shown. */
export const rewriteLlm = (fn: (text: string) => string, tokens = 120): FakeLlm =>
  new FakeLlm((req) => ({ text: fn(documentOf(req)), tokens }));

export class FakeSearch implements SearchClient {
  configured = true;
  queries: string[] = [];
  constructor(private readonly results: SearchResult[] | ((q: string) => SearchResult[])) {}
  async search(query: string): Promise<SearchResult[]> {
    this.queries.push(query);
    return typeof this.results === 'function' ? this.results(query) : this.results;
  }
}

export const page = (url: string, text: string, title = 'Page'): FetchedPage => ({
  url,
  title,
  text,
  truncated: false,
});

/** A promise you resolve by hand, to hold a model call open while the test does other things. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value. */
export async function until<T>(
  fn: () => T | Promise<T>,
  ms = 5000,
  what = 'condition',
): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

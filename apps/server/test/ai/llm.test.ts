import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmError, OpenAiCompatClient } from '../../src/ai/llm.js';
import { TavilyClient, SearchError } from '../../src/ai/web/search.js';

interface Seen {
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

describe('OpenAiCompatClient against a local OpenAI-compatible server', () => {
  let server: http.Server;
  let base: string;
  let seen: Seen[] = [];
  let respond: (req: Seen, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const rec: Seen = {
          url: req.url ?? '',
          auth: req.headers.authorization,
          body: raw ? JSON.parse(raw) : {},
        };
        seen.push(rec);
        respond(rec, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen = [];
    respond = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-ratelimit-remaining-requests', '14000');
      res.setHeader('x-ratelimit-remaining-tokens', '5000');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    };
  });

  const client = (over: Record<string, unknown> = {}) =>
    new OpenAiCompatClient({ baseUrl: base, model: 'm', apiKey: 'SERVER-KEY-123456', ...over });

  it('posts to /chat/completions with the server key and reads text, usage and headers', async () => {
    const out = await client().complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    });
    expect(out.text).toBe('hello');
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(out.headers['x-ratelimit-remaining-tokens']).toBe('5000');
    expect(seen[0]).toMatchObject({
      url: '/openai/v1/chat/completions',
      auth: 'Bearer SERVER-KEY-123456',
    });
    expect(seen[0]!.body).toMatchObject({ model: 'm', max_tokens: 50, temperature: 0 });
  });

  it("uses a user's own key for that request only, never the server key", async () => {
    const c = client();
    await c.complete({ messages: [], maxTokens: 5, apiKey: 'USER-KEY-abcdef' });
    await c.complete({ messages: [], maxTokens: 5 });
    expect(seen.map((s) => s.auth)).toEqual(['Bearer USER-KEY-abcdef', 'Bearer SERVER-KEY-123456']);
  });

  it('asks for JSON when told to, and probes with max_tokens=1', async () => {
    const c = client();
    await c.complete({ messages: [], maxTokens: 5, json: true });
    expect(seen[0]!.body.response_format).toEqual({ type: 'json_object' });
    const headers = await c.probe('USER-KEY-abcdef');
    expect(seen[1]!.body).toMatchObject({ max_tokens: 1 });
    expect(headers['x-ratelimit-remaining-requests']).toBe('14000');
  });

  it('asks gpt-oss models for low reasoning effort, and retries without it if the provider refuses', async () => {
    respond = (req, res) => {
      if ('reasoning_effort' in req.body) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'unknown parameter' } }));
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }),
      );
    };
    const out = await client({ model: 'openai/gpt-oss-20b' }).complete({
      messages: [],
      maxTokens: 20,
    });
    expect(out.text).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body.reasoning_effort).toBe('low');
    expect('reasoning_effort' in seen[1]!.body).toBe(false);
    // Other models never get the parameter at all.
    seen = [];
    await client({ model: 'llama-3.3-70b' }).complete({ messages: [], maxTokens: 20 });
    expect('reasoning_effort' in seen[0]!.body).toBe(false);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not-found'],
    [429, 'rate-limit'],
    [400, 'bad-request'],
    [500, 'server'],
    [503, 'server'],
  ])('maps HTTP %i to %s without leaking anything', async (status, kind) => {
    respond = (_req, res) => {
      res.statusCode = status;
      res.setHeader('retry-after', '7');
      res.end(
        JSON.stringify({
          error: { message: `echoed: Bearer ${'USER-KEY-abcdef'} tokens per minute (TPM)` },
        }),
      );
    };
    const err = (await client()
      .complete({
        messages: [{ role: 'user', content: 'private text' }],
        maxTokens: 5,
        apiKey: 'USER-KEY-abcdef',
      })
      .catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe(kind === 'bad-request' ? 'bad-request' : kind);
    expect(err.headers['retry-after']).toBe('7');
    // The error carries codes only: not the key, not the prompt, not the provider's own words.
    const shown = `${err.message} ${JSON.stringify(err)} ${String(err.stack).split('\n')[0]}`;
    expect(shown).not.toContain('USER-KEY-abcdef');
    expect(shown).not.toContain('private text');
    expect(shown).not.toContain('echoed');
    if (status === 429) expect(err.limit).toBe('minute'); // read once, then the text is discarded
  });

  it('reports a dead server and a slow server as network and timeout, not as raw errors', async () => {
    const dead = new OpenAiCompatClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'm',
      apiKey: 'k',
    });
    expect(
      ((await dead.complete({ messages: [], maxTokens: 1 }).catch((e) => e)) as LlmError).kind,
    ).toBe('network');
    respond = () => undefined; // never answers
    const slow = client({ timeoutMs: 100 });
    expect(
      ((await slow.complete({ messages: [], maxTokens: 1 }).catch((e) => e)) as LlmError).kind,
    ).toBe('timeout');
  });

  it('is not configured without any key, and a user key makes it usable', async () => {
    const bare = new OpenAiCompatClient({ baseUrl: 'https://api.example.test/v1', model: 'm' });
    expect(bare.serverKeyConfigured).toBe(false);
    expect(
      ((await bare.complete({ messages: [], maxTokens: 1 }).catch((e) => e)) as LlmError).kind,
    ).toBe('not-configured');
    expect(
      new OpenAiCompatClient({ baseUrl: 'http://localhost:11434/v1', model: 'm' })
        .serverKeyConfigured,
    ).toBe(true);
  });

  it('does not expose its key through JSON or inspection', () => {
    const c = client();
    expect(JSON.stringify(c)).not.toContain('SERVER-KEY');
    expect(JSON.stringify(Object.entries(c))).not.toContain('SERVER-KEY');
  });
});

describe('TavilyClient against a fake Tavily endpoint', () => {
  const fakeFetch = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('sends the key as a Bearer token and returns normalised, de-duplicated web results', async () => {
    const { f, calls } = fakeFetch(200, {
      results: [
        { title: 'A', url: 'https://a.example/x', content: 'about a', score: 0.9 },
        { title: 'dup', url: 'https://a.example/x', content: 'same url' },
        { title: 'js', url: 'javascript:alert(1)', content: 'bad scheme' },
        { title: 'file', url: 'file:///etc/passwd', content: 'bad scheme' },
        { title: 'creds', url: 'https://u:p@c.example/', content: 'credentials' },
        { title: 'B', url: 'https://b.example/', content: 'x'.repeat(2000) },
      ],
    });
    const out = await new TavilyClient({ apiKey: 'tvly-KEY-1234567890', fetch: f }).search(
      'yjs relative positions',
    );
    expect(out.map((r) => r.url)).toEqual(['https://a.example/x', 'https://b.example/']);
    expect(out[1]!.snippet.length).toBe(800);
    expect(calls[0]!.url).toBe('https://api.tavily.com/search');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer tvly-KEY-1234567890',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      query: 'yjs relative positions',
      search_depth: 'basic',
    });
  });

  it('maps failures to codes without detail and is unconfigured without a key', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [429, 'rate-limit'],
      [432, 'rate-limit'],
      [500, 'server'],
    ] as const) {
      const { f } = fakeFetch(status, { detail: { error: 'tvly-KEY-1234567890 is bad' } });
      const err = (await new TavilyClient({ apiKey: 'tvly-KEY-1234567890', fetch: f })
        .search('q')
        .catch((e) => e)) as SearchError;
      expect(err.kind).toBe(kind);
      expect(JSON.stringify(err) + err.message).not.toContain('tvly-KEY');
    }
    const none = new TavilyClient({});
    expect(none.configured).toBe(false);
    expect(((await none.search('q').catch((e) => e)) as SearchError).kind).toBe('not-configured');
    expect(JSON.stringify(new TavilyClient({ apiKey: 'tvly-KEY-1234567890' }))).not.toContain(
      'tvly-KEY',
    );
  });
});

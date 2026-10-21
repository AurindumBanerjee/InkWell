import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AiSecrets } from '../src/ai/config.js';
import { loadConfig } from '../src/config.js';
import { Client, setupApp, type TestCtx } from './helpers.js';

const SECRET = 'sk-test-DO-NOT-LEAK-0123456789';
const SEARCH_SECRET = 'search-test-DO-NOT-LEAK-9876543210';

describe('AI_FEATURES on (the AI version)', () => {
  let ctx: TestCtx;
  let base: string;
  let user: Client;

  beforeAll(async () => {
    ctx = await setupApp({
      ai: true,
      // The LLM and search providers are never contacted here: only keys' presence is reported.
      env: {
        LLM_BASE_URL: 'https://llm.example.test/v1',
        LLM_MODEL: 'fake-1',
        LLM_API_KEY: SECRET,
        TAVILY_API_KEY: SEARCH_SECRET,
      },
    });
    base = await ctx.listen();
    user = await new Client(ctx.app).login('someone@example.com');
  });
  afterAll(() => ctx.close());

  it('parses the flag', () => {
    expect(loadConfig({ DATABASE_URL: 'x', AI_FEATURES: 'true' }).AI_FEATURES).toBe(true);
  });

  it('registers the AI status route, for signed-in users only', async () => {
    const res = await user.req('GET', '/ai/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      llmConfigured: true,
      searchConfigured: true,
    });
    expect((await ctx.app.inject({ method: 'GET', url: '/ai/status' })).statusCode).toBe(401);
  });

  it('never returns a key value, only whether one is configured', async () => {
    const body = (await user.req('GET', '/ai/status')).body;
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(SEARCH_SECRET);
  });

  it('reports "not configured" when the deployment has no keys', async () => {
    const bare = await setupApp({ ai: true, env: {} });
    try {
      const c = await new Client(bare.app).login('x@example.com');
      expect((await c.req('GET', '/ai/status')).json()).toMatchObject({
        enabled: true,
        llmConfigured: false,
        searchConfigured: false,
      });
    } finally {
      await bare.close();
    }
  });

  it('registers the AI WebSocket route and requires a session', async () => {
    const open = (cookie?: string) =>
      new Promise<{ code?: number; first?: string }>((resolve) => {
        const ws = new WebSocket(`${base}/ws/ai`, { headers: cookie ? { cookie } : {} });
        ws.on('message', (d) => {
          resolve({ first: d.toString() });
          ws.close();
        });
        ws.on('close', (code) => resolve({ code }));
        ws.on('error', () => undefined);
      });
    expect(JSON.parse((await open(user.cookie)).first!)).toMatchObject({ type: 'ready' });
    expect((await open()).code).toBe(4401);
  });

  it('keeps keys out of JSON, console and inspect output', () => {
    const secrets = new AiSecrets({ LLM_API_KEY: SECRET, TAVILY_API_KEY: SEARCH_SECRET });
    for (const text of [
      JSON.stringify(secrets),
      inspect(secrets),
      `${inspect(secrets, { depth: 9 })}`,
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SEARCH_SECRET);
    }
    expect(secrets.llmKey()).toBe(SECRET); // still usable by the code that needs it
  });
});

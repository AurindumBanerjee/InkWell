import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { Client, setupApp, type TestCtx } from './helpers.js';

/**
 * With AI_FEATURES off the normal version of the app must contain no AI behaviour at all. These
 * tests are in their own file because Vitest isolates modules per file: the AI module below is
 * replaced by one that throws if it is ever loaded, which would fail the whole file.
 */
vi.mock('../src/ai/index.js', () => {
  throw new Error('src/ai/index.js was loaded although AI_FEATURES is off');
});

/** Names of the variables only the AI build may read. */
const AI_KEYS = ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY', 'SEARCH_API_KEY'];

/** An environment that records every property read, so "no key was read" is a checked fact. */
function recordingEnv(values: Record<string, string>) {
  const reads = new Set<string>();
  const env = new Proxy(values, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') reads.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string') reads.add(prop);
      return Reflect.has(target, prop);
    },
  }) as NodeJS.ProcessEnv;
  return { env, reads };
}

describe('AI_FEATURES off (the normal version)', () => {
  let ctx: TestCtx;
  let base: string;
  let user: Client;
  const spy = recordingEnv({
    LLM_PROVIDER: 'some-provider',
    LLM_MODEL: 'some-model',
    LLM_API_KEY: 'sk-should-never-be-read',
    SEARCH_API_KEY: 'search-should-never-be-read',
  });

  beforeAll(async () => {
    ctx = await setupApp({ ai: false, env: spy.env });
    base = await ctx.listen();
    user = await new Client(ctx.app).login('someone@example.com');
  });
  afterAll(() => ctx.close());

  it('defaults to off', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).AI_FEATURES).toBe(false);
    expect(loadConfig({ DATABASE_URL: 'x', AI_FEATURES: 'false' }).AI_FEATURES).toBe(false);
  });

  it('rejects ambiguous flag values instead of guessing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', AI_FEATURES: 'yes' })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: 'x', AI_FEATURES: '1' })).toThrow();
  });

  it('serves no AI HTTP route, even to a signed-in user', async () => {
    for (const url of ['/ai/status', '/ai', '/ai/anything']) {
      const res = await user.req('GET', url);
      expect(res.statusCode, url).toBe(404);
    }
    expect((await user.req('POST', '/ai/suggest', {})).statusCode).toBe(404);
  });

  it('has no AI WebSocket route: the upgrade is refused with 404', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}/ws/ai`, { headers: { cookie: user.cookie } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => undefined);
    });
    expect(status).toBe(404);
  });

  it('never read an LLM or search key from the environment', () => {
    // The environment above was handed to the app at build time; if anything had looked at an
    // AI variable, it would be in this set.
    expect([...spy.reads].filter((k) => AI_KEYS.includes(k))).toEqual([]);
  });

  it('config loading itself never touches AI variables', () => {
    const { env, reads } = recordingEnv({
      DATABASE_URL: 'postgres://x',
      AI_FEATURES: 'false',
      LLM_API_KEY: 'sk-never',
      SEARCH_API_KEY: 'never',
    });
    loadConfig(env);
    expect([...reads].filter((k) => AI_KEYS.includes(k))).toEqual([]);
  });

  it('leaves the normal features untouched', async () => {
    expect((await user.req('GET', '/workspaces')).statusCode).toBe(200);
    expect((await user.req('GET', '/search?q=anything')).statusCode).toBe(200);
  });
});

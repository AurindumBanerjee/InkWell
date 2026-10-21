import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkInstance, parseEnv } from './check-instance.mjs';

const good = {
  INSTANCE: 'normal',
  WEB_ORIGIN: 'https://inkwell.example.com',
  PUBLIC_URL: 'https://inkwell.example.com/api',
  NEXT_PUBLIC_API_URL: 'https://inkwell.example.com/api',
  NEXT_PUBLIC_WS_URL: 'wss://inkwell.example.com/ws',
  AI_FEATURES: 'false',
  NEXT_PUBLIC_AI_FEATURES: 'false',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
  POSTGRES_USER: 'inkwell',
  POSTGRES_PASSWORD: 'a-long-url-safe-password-123',
  POSTGRES_DB: 'inkwell_normal',
};
const errorsOf = (over, opts) => checkInstance({ ...good, ...over }, opts).errors;

test('a consistent normal instance passes', () => assert.deepEqual(errorsOf({}), []));

test('a consistent AI instance passes', () => {
  assert.deepEqual(
    errorsOf({
      INSTANCE: 'ai',
      AI_FEATURES: 'true',
      NEXT_PUBLIC_AI_FEATURES: 'true',
      LLM_API_KEY: 'k',
    }),
    [],
  );
});

test('server and web flags must agree', () => {
  assert.match(errorsOf({ AI_FEATURES: 'true' }).join('\n'), /must agree/);
  assert.match(errorsOf({ NEXT_PUBLIC_AI_FEATURES: 'true' }).join('\n'), /must agree/);
});

test('flag values are strict', () => {
  const e = errorsOf({ AI_FEATURES: 'yes', NEXT_PUBLIC_AI_FEATURES: 'yes' });
  assert.match(e.join('\n'), /exactly/);
});

test('the normal version holds no AI key', () => {
  for (const key of ['LLM_API_KEY', 'TAVILY_API_KEY', 'LLM_BASE_URL']) {
    assert.match(errorsOf({ [key]: 'x' }).join('\n'), new RegExp(`${key} is set but AI is off`));
  }
});

test('URLs must derive from one origin', () => {
  assert.match(
    errorsOf({ PUBLIC_URL: 'https://other.example.com/api' }).join('\n'),
    /PUBLIC_URL must be/,
  );
  assert.match(
    errorsOf({ NEXT_PUBLIC_WS_URL: 'ws://inkwell.example.com/ws' }).join('\n'),
    /NEXT_PUBLIC_WS_URL must be/,
  );
  assert.match(
    errorsOf({ WEB_ORIGIN: 'https://inkwell.example.com/app' }).join('\n'),
    /origin only/,
  );
});

test('dev login is refused and weak or unsafe secrets are caught', () => {
  assert.match(errorsOf({ ENABLE_DEV_LOGIN: 'true' }).join('\n'), /ENABLE_DEV_LOGIN/);
  assert.match(errorsOf({ POSTGRES_PASSWORD: 'short' }).join('\n'), /16\+ URL-safe/);
  assert.match(errorsOf({ POSTGRES_PASSWORD: 'has/slash/in/it/xxxxxxxx' }).join('\n'), /URL-safe/);
  assert.match(
    errorsOf({ GITHUB_CLIENT_SECRET: '' }).join('\n'),
    /GITHUB_CLIENT_SECRET is required/,
  );
});

const read = (f) =>
  parseEnv(readFileSync(new URL(`./instances/${f}.env.example`, import.meta.url), 'utf8'));

test('the committed templates are internally consistent (placeholders allowed)', () => {
  for (const f of ['normal', 'ai']) {
    assert.deepEqual(checkInstance(read(f), { template: true }).errors, [], f);
  }
});

test('the two templates differ where they must, so two instances never collide', () => {
  const n = read('normal');
  const a = read('ai');
  for (const k of ['INSTANCE', 'HTTP_PORT', 'WEB_ORIGIN', 'POSTGRES_DB'])
    assert.notEqual(n[k], a[k], k);
  assert.equal(n.AI_FEATURES, 'false');
  assert.equal(a.AI_FEATURES, 'true');
});

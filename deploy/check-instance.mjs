// Validates an instance env file before it is used to deploy.
//   node deploy/check-instance.mjs deploy/instances/normal.env
//   node deploy/check-instance.mjs --template deploy/instances/ai.env.example   (placeholders allowed)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

const AI_SECRET_KEYS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'TAVILY_API_KEY'];

/** @returns {{ errors: string[], warnings: string[] }} */
export function checkInstance(env, { template = false } = {}) {
  const errors = [];
  const warnings = [];
  const need = (key) => {
    if (!env[key]) errors.push(`${key} is required`);
    return env[key] ?? '';
  };

  if (!/^[a-z0-9-]+$/.test(env.INSTANCE ?? '')) {
    errors.push('INSTANCE must be lowercase letters, digits or -');
  }

  // The two flags are one decision made in two places (server runtime, web build).
  const server = env.AI_FEATURES ?? 'false';
  const web = env.NEXT_PUBLIC_AI_FEATURES ?? 'false';
  for (const [k, v] of [
    ['AI_FEATURES', server],
    ['NEXT_PUBLIC_AI_FEATURES', web],
  ]) {
    if (v !== 'true' && v !== 'false')
      errors.push(`${k} must be exactly "true" or "false" (got "${v}")`);
  }
  if (server !== web) {
    errors.push(
      `AI_FEATURES (${server}) and NEXT_PUBLIC_AI_FEATURES (${web}) must agree: a half-enabled instance`,
    );
  }
  if (server === 'false') {
    for (const k of AI_SECRET_KEYS) {
      if (env[k])
        errors.push(`${k} is set but AI is off: remove it so the normal version holds no AI key`);
    }
  }

  if (env.ENABLE_DEV_LOGIN === 'true') {
    errors.push('ENABLE_DEV_LOGIN must not be true in a deployed instance');
  }

  // One public origin; every URL derives from it.
  try {
    const origin = new URL(need('WEB_ORIGIN'));
    if (origin.pathname !== '/' || origin.search || origin.hash) {
      errors.push('WEB_ORIGIN must be an origin only (no path)');
    }
    if (!template && origin.protocol !== 'https:') {
      warnings.push('WEB_ORIGIN is not https: cookies are Secure-only in production');
    }
    const base = origin.origin;
    if (env.PUBLIC_URL !== `${base}/api`) {
      errors.push(`PUBLIC_URL must be ${base}/api (the OAuth callback is served under /api)`);
    }
    if (env.NEXT_PUBLIC_API_URL !== `${base}/api`)
      errors.push(`NEXT_PUBLIC_API_URL must be ${base}/api`);
    const ws = `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}/ws`;
    if (env.NEXT_PUBLIC_WS_URL !== ws) errors.push(`NEXT_PUBLIC_WS_URL must be ${ws}`);
  } catch {
    errors.push('WEB_ORIGIN must be a valid URL');
  }

  need('POSTGRES_USER');
  need('POSTGRES_DB');
  if (!template) {
    need('GITHUB_CLIENT_ID');
    need('GITHUB_CLIENT_SECRET');
    const pw = need('POSTGRES_PASSWORD');
    if (pw && !/^[A-Za-z0-9._~-]{16,}$/.test(pw)) {
      errors.push('POSTGRES_PASSWORD must be 16+ URL-safe characters (letters, digits, . _ ~ -)');
    }
    if (server === 'true' && !env.LLM_API_KEY) {
      warnings.push('AI is on but LLM_API_KEY is empty: the AI will report "no model configured"');
    }
  }
  if (!env.SENTRY_DSN) warnings.push('SENTRY_DSN is empty: error tracking is off');
  return { errors, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const template = args.includes('--template');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node deploy/check-instance.mjs [--template] <env file>');
    process.exit(2);
  }
  const { errors, warnings } = checkInstance(parseEnv(readFileSync(file, 'utf8')), { template });
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error:   ${e}`);
  console.log(errors.length ? `${file}: ${errors.length} problem(s)` : `${file}: ok`);
  process.exit(errors.length ? 1 : 0);
}

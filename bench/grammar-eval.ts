/**
 * Grammar-mode evaluation against the real model: 50 sentences (bench/grammar-cases.ts), the same
 * prompt, output cleaning and contract check the server uses.
 *
 *   npx tsx --env-file=.env bench/grammar-eval.ts
 *
 * Reads LLM_API_KEY / LLM_BASE_URL / LLM_MODEL from the environment only; nothing about the key is
 * printed or written. Sequential, one request at a time. Results: bench/results/grammar-eval.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadAiSecrets } from '../apps/server/src/ai/config.js';
import { OpenAiCompatClient } from '../apps/server/src/ai/llm.js';
import { cleanRewriteOutput, modeById } from '../apps/server/src/ai/modes.js';
import { GRAMMAR_CASES } from './grammar-cases.js';

const secrets = loadAiSecrets(process.env);
if (!secrets.llmConfigured) {
  console.error('LLM_API_KEY is not set in the environment.');
  process.exit(1);
}
const client = new OpenAiCompatClient({
  baseUrl: secrets.baseUrl,
  model: secrets.model,
  apiKey: secrets.llmKey(),
});
const mode = modeById('grammar')!;

interface Row {
  input: string;
  expected: string;
  output: string | null;
  clean: boolean;
  exact: boolean;
  contract: string | null; // reason code if the server would have rejected it
  error?: string;
  ms: number;
  tokens: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Free-tier rate limits are expected: wait and retry a few times before recording a failure. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { kind?: string }).kind !== 'rate-limit' || attempt >= 4) throw e;
      await sleep(15_000 * (attempt + 1));
    }
  }
}

const rows: Row[] = [];
let tokens = 0;
for (const c of GRAMMAR_CASES) {
  const t0 = Date.now();
  const clean = c.input === c.expected;
  try {
    const completion = await withRetry(() =>
      client.complete({
        messages: [
          { role: 'system', content: mode.system ?? '' },
          { role: 'user', content: `<document>\n${c.input}\n</document>` },
        ],
        maxTokens: Math.max(300, Math.ceil(c.input.length / 4) * 2 + 1500),
        temperature: mode.temperature,
      }),
    );
    const output = cleanRewriteOutput(completion.text, c.input);
    tokens += completion.usage.totalTokens;
    rows.push({
      ...c,
      output,
      clean,
      exact: output.trim() === c.expected.trim(),
      contract: mode.check?.(c.input, output) ?? null,
      ms: Date.now() - t0,
      tokens: completion.usage.totalTokens,
    });
  } catch (e) {
    // Only the error class is kept: provider error text is never recorded.
    rows.push({
      ...c,
      output: null,
      clean,
      exact: false,
      contract: null,
      error: (e as { kind?: string }).kind ?? 'error',
      ms: Date.now() - t0,
      tokens: 0,
    });
  }
  await sleep(2_500);
}

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const bad = rows.filter((r) => !r.clean);
const ok = rows.filter((r) => r.clean);
const answered = rows.filter((r) => r.output !== null);
const summary = {
  model: secrets.model,
  baseUrl: new URL(secrets.baseUrl).host,
  date: new Date().toISOString().slice(0, 10),
  cases: rows.length,
  withErrors: bad.length,
  alreadyCorrect: ok.length,
  requestFailures: rows.length - answered.length,
  // Rates are over answered cases only; failed requests are reported separately above.
  exactFixRate: pct(
    bad.filter((r) => r.exact).length,
    bad.filter((r) => r.output !== null).length,
  ),
  unchangedWhenCorrectRate: pct(
    ok.filter((r) => r.exact).length,
    ok.filter((r) => r.output !== null).length,
  ),
  contractRejections: answered.filter((r) => r.contract).length,
  medianMs: [...answered.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(answered.length / 2)],
  totalTokens: tokens,
};
mkdirSync('bench/results', { recursive: true });
writeFileSync('bench/results/grammar-eval.json', JSON.stringify({ summary, rows }, null, 2));
console.log(summary);
console.log('misses:');
for (const r of rows.filter((x) => !x.exact && x.output !== null))
  console.log(JSON.stringify({ in: r.input, want: r.expected, got: r.output, c: r.contract, e: r.error }));

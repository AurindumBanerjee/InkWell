import { inspect } from 'node:util';
import { z } from 'zod';

/**
 * Everything the AI build reads from the environment lives here and nowhere else. The module is
 * imported dynamically and only when AI_FEATURES is on, so with the flag off none of these
 * variables is ever read.
 */
export const AI_ENV_KEYS = [
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'LLM_TEMPERATURE',
  'SEARCH_PROVIDER',
  'TAVILY_API_KEY',
  'AI_ALLOWED_EMAILS',
  'AI_RATE_PER_MINUTE',
  'AI_RATE_PER_DAY',
  'AI_DAILY_TOKEN_BUDGET',
  'AI_REQUEST_TOKEN_BUDGET',
  'AI_EXPAND_TOKEN_BUDGET',
  'AI_MAX_STEPS',
  'AI_MAX_INPUT_CHARS',
  'AI_MAX_CONCURRENT_PER_USER',
  'AI_MAX_CONCURRENT_TOTAL',
  'AI_RUN_TIMEOUT_MS',
] as const;

/**
 * The deployment's provider keys. The values are private fields: they never appear in
 * JSON.stringify, console.log, util.inspect or structured logs; callers must ask for a key
 * explicitly at the moment of use.
 */
export class AiSecrets {
  readonly #llmKey: string | undefined;
  readonly #searchKey: string | undefined;
  /** Non-secret provider settings. */
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature: number;
  readonly searchProvider: string;

  constructor(env: NodeJS.ProcessEnv) {
    this.#llmKey = env.LLM_API_KEY?.trim() || undefined;
    this.#searchKey = env.TAVILY_API_KEY?.trim() || undefined;
    this.baseUrl = env.LLM_BASE_URL?.trim() || 'https://api.groq.com/openai/v1';
    this.model = env.LLM_MODEL?.trim() || 'openai/gpt-oss-20b';
    const t = Number(env.LLM_TEMPERATURE);
    this.temperature = env.LLM_TEMPERATURE && Number.isFinite(t) ? t : 0;
    this.searchProvider = env.SEARCH_PROVIDER?.trim() || 'tavily';
  }

  get llmConfigured(): boolean {
    return this.#llmKey !== undefined;
  }
  get searchConfigured(): boolean {
    return this.#searchKey !== undefined;
  }
  /** The server-side key, for the call that needs it. Never store or log the result. */
  llmKey(): string | undefined {
    return this.#llmKey;
  }
  searchKey(): string | undefined {
    return this.#searchKey;
  }

  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      model: this.model,
      searchProvider: this.searchProvider,
      llmKey: this.llmConfigured ? '[set]' : '[unset]',
      searchKey: this.searchConfigured ? '[set]' : '[unset]',
    };
  }
  [inspect.custom](): string {
    return `AiSecrets ${JSON.stringify(this.toJSON())}`;
  }
}

export const loadAiSecrets = (env: NodeJS.ProcessEnv): AiSecrets => new AiSecrets(env);

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

/** Safeguards and limits. All have safe defaults; deployments tune them by environment variable. */
const settingsSchema = z.object({
  /** Comma-separated emails. Empty = any signed-in user; set = invite-only. */
  AI_ALLOWED_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  AI_RATE_PER_MINUTE: int(4, 1),
  AI_RATE_PER_DAY: int(60, 1),
  /** Tokens per UTC day on the shared key across all users; 0 disables the cap. */
  AI_DAILY_TOKEN_BUDGET: int(300_000),
  /** Per-request token budgets (all model calls of one run). */
  AI_REQUEST_TOKEN_BUDGET: int(6_000, 500),
  AI_EXPAND_TOKEN_BUDGET: int(40_000, 2_000),
  AI_MAX_STEPS: int(8, 1),
  /** Longest selection a run accepts, in characters. */
  AI_MAX_INPUT_CHARS: int(12_000, 200),
  AI_MAX_CONCURRENT_PER_USER: int(1, 1),
  AI_MAX_CONCURRENT_TOTAL: int(4, 1),
  AI_RUN_TIMEOUT_MS: int(120_000, 5_000),
});

export interface AiSettings {
  allowedEmails: string[];
  ratePerMinute: number;
  ratePerDay: number;
  dailyTokenBudget: number;
  requestTokenBudget: number;
  expandTokenBudget: number;
  maxSteps: number;
  maxInputChars: number;
  maxConcurrentPerUser: number;
  maxConcurrentTotal: number;
  runTimeoutMs: number;
}

export function loadAiSettings(env: NodeJS.ProcessEnv): AiSettings {
  const raw = Object.fromEntries(
    Object.keys(settingsSchema.shape).map((k) => [k, env[k]]),
  ) as Record<string, string | undefined>;
  const s = settingsSchema.parse(raw);
  return {
    allowedEmails: s.AI_ALLOWED_EMAILS,
    ratePerMinute: s.AI_RATE_PER_MINUTE,
    ratePerDay: s.AI_RATE_PER_DAY,
    dailyTokenBudget: s.AI_DAILY_TOKEN_BUDGET,
    requestTokenBudget: s.AI_REQUEST_TOKEN_BUDGET,
    expandTokenBudget: s.AI_EXPAND_TOKEN_BUDGET,
    maxSteps: s.AI_MAX_STEPS,
    maxInputChars: s.AI_MAX_INPUT_CHARS,
    maxConcurrentPerUser: s.AI_MAX_CONCURRENT_PER_USER,
    maxConcurrentTotal: s.AI_MAX_CONCURRENT_TOTAL,
    runTimeoutMs: s.AI_RUN_TIMEOUT_MS,
  };
}

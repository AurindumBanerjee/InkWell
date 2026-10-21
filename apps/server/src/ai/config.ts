import { inspect } from 'node:util';

/**
 * Environment variables only the AI build reads. Nothing outside src/ai/ may touch them, and
 * nothing here runs unless AI_FEATURES is on (the module is imported dynamically).
 */
export const AI_ENV_KEYS = ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY', 'SEARCH_API_KEY'] as const;

/**
 * Holds the deployment's provider keys. The values are private fields: they never appear in
 * JSON.stringify, console.log, util.inspect or structured logs; callers must ask for a key
 * explicitly at the moment of use.
 */
export class AiSecrets {
  readonly #llmKey: string | undefined;
  readonly #searchKey: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    this.provider = env.LLM_PROVIDER || undefined;
    this.model = env.LLM_MODEL || undefined;
    this.#llmKey = env.LLM_API_KEY || undefined;
    this.#searchKey = env.SEARCH_API_KEY || undefined;
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
      provider: this.provider,
      model: this.model,
      llmKey: this.llmConfigured ? '[set]' : '[unset]',
      searchKey: this.searchConfigured ? '[set]' : '[unset]',
    };
  }
  [inspect.custom](): string {
    return `AiSecrets ${JSON.stringify(this.toJSON())}`;
  }
}

export const loadAiSecrets = (env: NodeJS.ProcessEnv): AiSecrets => new AiSecrets(env);

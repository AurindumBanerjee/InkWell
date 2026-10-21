import { limitKind, type HeaderBag } from './usage.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask for a JSON object (used by the ReAct loop). */
  json?: boolean;
  /** A user's own key for this request only. Never stored, never logged. */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface Completion {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Response headers, for rate-limit readings. */
  headers: Record<string, string>;
}

export type LlmErrorKind =
  | 'auth' // the key was rejected
  | 'not-found' // the model is not available to this key
  | 'rate-limit' // 429
  | 'bad-request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'not-configured';

/**
 * A provider failure with everything safe to show and nothing else: no request body, no key,
 * no provider message text (some providers echo parts of the request back).
 */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly status?: number,
    readonly headers: Record<string, string> = {},
    /**
     * The provider's own 429 message. It is read once, to tell a daily limit from a per-minute one,
     * and then discarded: providers sometimes echo parts of the request back in error text, so the
     * text itself must never be kept on an object that could be logged or serialised.
     */
    providerMessage?: string,
  ) {
    super(`LLM request failed: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'LlmError';
    this.limit = limitKind(providerMessage);
  }

  /** Which rate limit a 429 was about, if the provider said. */
  readonly limit?: 'day' | 'minute';
}

export interface LlmClient {
  /** Whether the deployment has its own (shared) key, or an endpoint that needs none. */
  readonly serverKeyConfigured: boolean;
  complete(req: CompletionRequest): Promise<Completion>;
  /** One minimal request (max_tokens=1); returns the response headers. Validates a key and reads limits. */
  probe(apiKey?: string): Promise<Record<string, string>>;
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  model: string;
  /** The deployment's shared key, if any. */
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Reasoning effort for models that think before answering (gpt-oss on Groq). Thinking tokens
   * count against max_tokens, so "low" keeps a small budget from being spent before any answer.
   * Defaults to "low" for gpt-oss models and is omitted for others.
   */
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
}

const headersToObject = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
};

/** Talks to any OpenAI-compatible chat endpoint (Groq by default). Plain fetch, no SDK. */
export class OpenAiCompatClient implements LlmClient {
  private readonly doFetch: typeof fetch;

  readonly #opts: OpenAiCompatOptions; // ES-private: never serialised, never shown by util.inspect

  constructor(opts: OpenAiCompatOptions) {
    this.#opts = opts;
    this.doFetch = opts.fetch ?? fetch;
  }

  get serverKeyConfigured(): boolean {
    const local = /localhost|127\.0\.0\.1/.test(this.#opts.baseUrl);
    return Boolean(this.#opts.apiKey) || local;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    return this.call(
      {
        model: this.#opts.model,
        temperature: req.temperature ?? this.#opts.temperature ?? 0,
        max_tokens: req.maxTokens,
        messages: req.messages,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
      req.apiKey,
      req.signal,
    );
  }

  async probe(apiKey?: string): Promise<Record<string, string>> {
    const { headers } = await this.call(
      { model: this.#opts.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      apiKey,
    );
    return headers;
  }

  private effort(): string | undefined {
    const e = this.#opts.reasoningEffort;
    if (e === null) return undefined;
    return e ?? (/gpt-oss/i.test(this.#opts.model) ? 'low' : undefined);
  }

  private async call(body: object, userKey?: string, signal?: AbortSignal): Promise<Completion> {
    const effort = this.effort();
    if (!effort) return this.send(body, userKey, signal);
    try {
      return await this.send({ ...body, reasoning_effort: effort }, userKey, signal);
    } catch (err) {
      // A model that does not know the parameter answers 400: retry once without it.
      if (err instanceof LlmError && err.kind === 'bad-request')
        return this.send(body, userKey, signal);
      throw err;
    }
  }

  private async send(body: object, userKey?: string, signal?: AbortSignal): Promise<Completion> {
    const key = userKey || this.#opts.apiKey;
    if (!key && !this.serverKeyConfigured) throw new LlmError('not-configured');

    const timeout = AbortSignal.timeout(this.#opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.doFetch(`${this.#opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      // The caught error is deliberately dropped: network errors can carry request details.
      throw new LlmError(timeout.aborted ? 'timeout' : 'network');
    }

    const headers = headersToObject(res.headers);
    if (!res.ok) {
      const providerMessage = res.status === 429 ? await readErrorMessage(res) : undefined;
      const kind: LlmErrorKind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 404
            ? 'not-found'
            : res.status === 429
              ? 'rate-limit'
              : res.status >= 500
                ? 'server'
                : 'bad-request';
      throw new LlmError(kind, res.status, headers, providerMessage);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    const prompt = data.usage?.prompt_tokens ?? 0;
    const completion = data.usage?.completion_tokens ?? 0;
    return {
      text,
      usage: {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: data.usage?.total_tokens ?? prompt + completion,
      },
      headers,
    };
  }
}

async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message;
  } catch {
    return undefined;
  }
}

/** Rough token estimate (about 4 characters per token), used only when the provider reports none. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export type { HeaderBag };

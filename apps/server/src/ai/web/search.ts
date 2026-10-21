/** Web search for the Expand mode, behind a small interface so the provider can be swapped. */

export interface SearchResult {
  title: string;
  url: string;
  /** A short extract from the page. Untrusted text. */
  snippet: string;
}

export class SearchError extends Error {
  constructor(
    readonly kind: 'not-configured' | 'auth' | 'rate-limit' | 'server' | 'network',
    readonly status?: number,
  ) {
    super(`search failed: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'SearchError';
  }
}

export interface SearchClient {
  readonly configured: boolean;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export interface TavilyOptions {
  /** From the server environment (TAVILY_API_KEY). Never sent to the browser. */
  apiKey?: string;
  maxResults?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const TAVILY_URL = 'https://api.tavily.com/search';

/** Only plain http(s) links can become sources; anything else in a result is dropped. */
const isWebUrl = (u: unknown): u is string => {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u);
    return (p.protocol === 'http:' || p.protocol === 'https:') && !p.username && !p.password;
  } catch {
    return false;
  }
};

export class TavilyClient implements SearchClient {
  private readonly doFetch: typeof fetch;
  readonly #opts: TavilyOptions; // ES-private: the key never shows up in JSON or util.inspect

  constructor(opts: TavilyOptions) {
    this.#opts = opts;
    this.doFetch = opts.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.#opts.apiKey);
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!this.#opts.apiKey) throw new SearchError('not-configured');
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.doFetch(TAVILY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#opts.apiKey}`,
        },
        body: JSON.stringify({
          query: query.slice(0, 300),
          search_depth: 'basic',
          max_results: this.#opts.maxResults ?? 5,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new SearchError('network'); // the caught error is dropped on purpose (may hold request details)
    }
    if (!res.ok) {
      throw new SearchError(
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429 || res.status === 432 || res.status === 433
            ? 'rate-limit'
            : 'server',
        res.status,
      );
    }
    const data = (await res.json()) as {
      results?: { title?: unknown; url?: unknown; content?: unknown }[];
    };
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of data.results ?? []) {
      if (!isWebUrl(r.url) || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({
        title: String(r.title ?? '').slice(0, 200),
        url: r.url,
        snippet: String(r.content ?? '').slice(0, 800),
      });
    }
    return out;
  }
}

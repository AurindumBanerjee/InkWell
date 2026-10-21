/**
 * Provider rate-limit readings: parse headers, keep the shared-key record, build the view the UI shows.
 *
 * What the numbers mean (Groq's documented headers; other providers may send none):
 *   x-ratelimit-*-requests  -> requests per DAY
 *   x-ratelimit-*-tokens    -> tokens per MINUTE
 *   retry-after             -> seconds, only present on a 429
 * The daily TOKEN limit is not in any header, so it is never shown as a balance.
 */

/** A shared-key refresh within this many seconds of the last reading reuses the reading. */
export const REFRESH_CACHE_SECONDS = 30;

export interface Limits {
  requestsLimit?: number; // per day
  requestsRemaining?: number; // per day
  requestsResetS?: number;
  tokensLimit?: number; // per minute
  tokensRemaining?: number; // per minute
  tokensResetS?: number;
}

const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };

/** '2m59.56s' -> 179.56, '7.66s' -> 7.66, '12' -> 12; anything else -> undefined. */
export function parseDuration(text: unknown): number | undefined {
  if (text === undefined || text === null) return undefined;
  const raw = String(text).trim().toLowerCase();
  if (!raw) return undefined;
  const parts = [...raw.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length > 0 && parts.map((p) => p[0]).join('') === raw) {
    return parts.reduce((sum, p) => sum + Number(p[1]) * UNIT_SECONDS[p[2]!]!, 0);
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const toInt = (v: unknown): number | undefined => {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

export type HeaderBag = Record<string, string | string[] | undefined> | Headers | undefined;

function lowerMap(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

/** Reads whatever rate-limit headers are present; missing ones stay undefined. */
export function parseLimits(headers: HeaderBag): Limits {
  const h = lowerMap(headers);
  return {
    requestsLimit: toInt(h['x-ratelimit-limit-requests']),
    requestsRemaining: toInt(h['x-ratelimit-remaining-requests']),
    requestsResetS: parseDuration(h['x-ratelimit-reset-requests']),
    tokensLimit: toInt(h['x-ratelimit-limit-tokens']),
    tokensRemaining: toInt(h['x-ratelimit-remaining-tokens']),
    tokensResetS: parseDuration(h['x-ratelimit-reset-tokens']),
  };
}

export const limitsAvailable = (l: Limits): boolean =>
  Object.values(l).some((v) => v !== undefined);

export function retryAfterSeconds(headers: HeaderBag): number | undefined {
  return parseDuration(lowerMap(headers)['retry-after']);
}

/** 'day' | 'minute' | undefined, read from a 429's message. Only picks a label; the text is never shown. */
export function limitKind(message: string | undefined): 'day' | 'minute' | undefined {
  const text = (message ?? '').toLowerCase();
  if (text.includes('per day') || text.includes('(tpd)') || text.includes('(rpd)')) return 'day';
  if (text.includes('per minute') || text.includes('(tpm)') || text.includes('(rpm)'))
    return 'minute';
  return undefined;
}

export function fmtDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 1) return 'under 1 s';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

export interface Reading {
  limits: Limits;
  takenAt: number; // ms
}
export interface Notice {
  kind?: 'day' | 'minute';
  retryAfterS?: number;
  takenAt: number;
}
export interface UsageBook {
  reading?: Reading;
  notice?: Notice;
  lastProbeAt: number;
}

export const emptyBook = (): UsageBook => ({ lastProbeAt: 0 });
export const withHeaders = (b: UsageBook, headers: HeaderBag, now: number): UsageBook => ({
  ...b,
  reading: { limits: parseLimits(headers), takenAt: now },
  notice: undefined,
});
export const withNotice = (
  b: UsageBook,
  kind: 'day' | 'minute' | undefined,
  retryAfterS: number | undefined,
  now: number,
): UsageBook => ({ ...b, notice: { kind, retryAfterS, takenAt: now } });

/** Process-wide record for the shared server key: one quota, shared by everyone. */
export class SharedUsage {
  private book: UsageBook = emptyBook();
  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): UsageBook {
    return this.book;
  }
  update(fn: (b: UsageBook) => UsageBook): UsageBook {
    return (this.book = fn(this.book));
  }
  /** Allows one refresh per cache window across all users. */
  claimRefresh(): boolean {
    const newest = Math.max(this.book.reading?.takenAt ?? 0, this.book.lastProbeAt);
    if (this.now() - newest < REFRESH_CACHE_SECONDS * 1000) return false;
    this.book = { ...this.book, lastProbeAt: this.now() };
    return true;
  }
}

/** One labelled line. `text` says what the number measures; the UI shows it as is. */
export interface UsageLine {
  label: string;
  text: string;
}

export interface UsageView {
  /** Which key these numbers describe. */
  scope: 'own' | 'shared';
  heading: string;
  lines: UsageLine[];
  /** A recent 429: which limit and when it should clear. */
  warning?: string;
  /** Always says what is NOT shown, so a missing number is never mistaken for "unlimited". */
  note?: string;
  ageS?: number;
}

const n = (v: number): string => v.toLocaleString('en-US');

/** The structured equivalent of Delphion Space's usage panel. */
export function usageView(own: boolean, book: UsageBook, now: number): UsageView {
  const view: UsageView = {
    scope: own ? 'own' : 'shared',
    heading: own
      ? 'Usage: your own key (this session only)'
      : 'Usage: shared server key (one quota shared by all users)',
    lines: [],
  };

  const notice = book.notice;
  if (notice) {
    const left =
      notice.retryAfterS === undefined
        ? undefined
        : notice.retryAfterS - (now - notice.takenAt) / 1000;
    if (left === undefined || left > 0) {
      const label =
        notice.kind === 'day' ? 'Daily' : notice.kind === 'minute' ? 'Per-minute' : 'Rate';
      view.warning = `${label} limit reached${left === undefined ? ', try again later' : `, resets in ${fmtDuration(left)}`}`;
    }
  }

  const r = book.reading;
  if (!r) {
    if (!notice)
      view.note = 'No reading yet. Run an AI request, or refresh (this uses one request).';
    return view;
  }

  const lim = r.limits;
  if (!limitsAvailable(lim)) {
    view.note = 'Limit information is not available for this provider.';
  } else {
    const reset = (s: number | undefined): string => {
      if (s === undefined) return '';
      const left = s - (now - r.takenAt) / 1000;
      return left > 0 ? ` (resets in ${fmtDuration(left)})` : ' (reset)';
    };
    if (lim.requestsRemaining !== undefined || lim.requestsLimit !== undefined) {
      const rem = lim.requestsRemaining === undefined ? '?' : n(lim.requestsRemaining);
      const tot = lim.requestsLimit === undefined ? '' : ` of ${n(lim.requestsLimit)}`;
      view.lines.push({
        label: 'Requests left today',
        text: `${rem}${tot}${reset(lim.requestsResetS)}`,
      });
    }
    if (lim.tokensRemaining !== undefined || lim.tokensLimit !== undefined) {
      const rem = lim.tokensRemaining === undefined ? '?' : n(lim.tokensRemaining);
      const tot = lim.tokensLimit === undefined ? '' : ` of ${n(lim.tokensLimit)}`;
      view.lines.push({
        label: 'Tokens left this minute',
        text: `${rem}${tot}${reset(lim.tokensResetS)}`,
      });
    }
    view.note = 'The daily token limit is not reported by the provider, so it is not shown.';
  }
  view.ageS = Math.max(0, (now - r.takenAt) / 1000);
  return view;
}

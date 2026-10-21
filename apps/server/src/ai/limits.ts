import type { Db } from '../db.js';

/** Per-user request limits: sliding windows held in memory (the AI instance is a single node). */
export interface RateLimitOptions {
  perMinute: number;
  perDay: number;
  now?: () => number;
}

export type RateDecision =
  { ok: true } | { ok: false; scope: 'minute' | 'day'; retryAfterS: number };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Checks without recording. Call `record` once the request is accepted. */
  check(userId: string): RateDecision {
    const t = this.now();
    const list = this.prune(userId, t);
    const lastMinute = list.filter((x) => x > t - 60_000);
    if (lastMinute.length >= this.opts.perMinute) {
      return {
        ok: false,
        scope: 'minute',
        retryAfterS: Math.ceil((lastMinute[0]! + 60_000 - t) / 1000),
      };
    }
    if (list.length >= this.opts.perDay) {
      return {
        ok: false,
        scope: 'day',
        retryAfterS: Math.ceil((list[0]! + 86_400_000 - t) / 1000),
      };
    }
    return { ok: true };
  }

  record(userId: string): void {
    const t = this.now();
    this.prune(userId, t).push(t);
  }

  /** Requests left in the rolling windows, for display. */
  remaining(userId: string): { minute: number; day: number } {
    const t = this.now();
    const list = this.prune(userId, t);
    return {
      minute: Math.max(0, this.opts.perMinute - list.filter((x) => x > t - 60_000).length),
      day: Math.max(0, this.opts.perDay - list.length),
    };
  }

  /** Drops hits older than a day and returns the live list (one small array per user). */
  private prune(userId: string, t: number): number[] {
    const list = (this.hits.get(userId) ?? []).filter((x) => x > t - 86_400_000);
    this.hits.set(userId, list);
    return list;
  }
}

/** Caps how many runs one user may have in flight, and how many the whole instance may. */
export class ConcurrencyGate {
  private readonly perUser = new Map<string, number>();
  private total = 0;
  constructor(
    private readonly maxPerUser: number,
    private readonly maxTotal: number,
  ) {}

  tryAcquire(userId: string): (() => void) | null {
    const mine = this.perUser.get(userId) ?? 0;
    if (mine >= this.maxPerUser || this.total >= this.maxTotal) return null;
    this.perUser.set(userId, mine + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.perUser.delete(userId);
      else this.perUser.set(userId, left);
    };
  }
}

export interface BudgetStatus {
  enabled: boolean;
  exhausted: boolean;
  usedToday: number;
  dailyBudget: number;
  /** ISO time the budget resets (next UTC midnight). */
  resetsAt: string;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number): string => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};

/**
 * Global daily token budget for the shared server key, persisted so a restart cannot reset it.
 * Requests made with a user's own key are not counted: they spend that user's own quota.
 * When the budget is spent the AI switches off cleanly until the next UTC day.
 */
export class DailyBudget {
  private cache?: { day: string; tokens: number };

  constructor(
    private readonly db: Db,
    private readonly dailyBudget: number,
    private readonly now: () => number = Date.now,
  ) {}

  async used(): Promise<number> {
    const day = utcDay(this.now());
    const { rows } = await this.db.query<{ tokens: string }>(
      'SELECT tokens FROM ai_usage_daily WHERE day = $1',
      [day],
    );
    const tokens = Number(rows[0]?.tokens ?? 0);
    this.cache = { day, tokens };
    return tokens;
  }

  async status(): Promise<BudgetStatus> {
    const usedToday = await this.used();
    return {
      enabled: this.dailyBudget > 0,
      exhausted: this.dailyBudget > 0 && usedToday >= this.dailyBudget,
      usedToday,
      dailyBudget: this.dailyBudget,
      resetsAt: nextUtcMidnight(this.now()),
    };
  }

  async isExhausted(): Promise<boolean> {
    return (await this.status()).exhausted;
  }

  /** Records tokens actually spent. Returns true if the budget is now exhausted. */
  async spend(tokens: number): Promise<boolean> {
    const day = utcDay(this.now());
    const { rows } = await this.db.query<{ tokens: string }>(
      `INSERT INTO ai_usage_daily (day, tokens, requests) VALUES ($1, $2, 1)
       ON CONFLICT (day) DO UPDATE SET tokens = ai_usage_daily.tokens + EXCLUDED.tokens,
                                       requests = ai_usage_daily.requests + 1
       RETURNING tokens`,
      [day, Math.max(0, Math.trunc(tokens))],
    );
    const total = Number(rows[0]!.tokens);
    this.cache = { day, tokens: total };
    return this.dailyBudget > 0 && total >= this.dailyBudget;
  }
}

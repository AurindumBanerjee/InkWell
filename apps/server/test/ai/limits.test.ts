import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConcurrencyGate, DailyBudget, RateLimiter } from '../../src/ai/limits.js';
import { setupApp, type TestCtx } from '../helpers.js';

describe('RateLimiter', () => {
  it('limits per user per minute and per day, and says when to retry', () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 2, perDay: 4, now: () => t });
    expect(rl.check('u')).toEqual({ ok: true });
    rl.record('u');
    rl.record('u');
    expect(rl.check('u')).toEqual({ ok: false, scope: 'minute', retryAfterS: 60 });
    expect(rl.remaining('u')).toEqual({ minute: 0, day: 2 });

    t = 30_000;
    expect(rl.check('u')).toMatchObject({ ok: false, scope: 'minute', retryAfterS: 30 });
    t = 61_000;
    expect(rl.check('u')).toEqual({ ok: true });
    rl.record('u');
    rl.record('u');
    // 4 in the day now, though only 2 in the last minute
    t = 125_000;
    expect(rl.check('u')).toMatchObject({ ok: false, scope: 'day' });
    t = 86_400_000 + 1000;
    expect(rl.check('u')).toEqual({ ok: true });
  });

  it('keeps users independent', () => {
    const rl = new RateLimiter({ perMinute: 1, perDay: 10, now: () => 0 });
    rl.record('a');
    expect(rl.check('a').ok).toBe(false);
    expect(rl.check('b').ok).toBe(true);
  });
});

describe('ConcurrencyGate', () => {
  it('caps runs per user and in total, and releases exactly once', () => {
    const gate = new ConcurrencyGate(1, 2);
    const a1 = gate.tryAcquire('a');
    expect(a1).toBeTruthy();
    expect(gate.tryAcquire('a')).toBeNull(); // per-user cap
    const b1 = gate.tryAcquire('b');
    expect(b1).toBeTruthy();
    expect(gate.tryAcquire('c')).toBeNull(); // total cap
    a1!();
    a1!(); // a second release must not free a second slot
    expect(gate.tryAcquire('c')).toBeTruthy();
    expect(gate.tryAcquire('d')).toBeNull();
    b1!();
    expect(gate.tryAcquire('d')).toBeTruthy();
  });
});

describe('DailyBudget (persisted)', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await setupApp({ ai: true }); // registering the AI module creates the AI tables
  });
  afterAll(() => ctx.close());

  it('adds up spending, reports exhaustion, and resets with the UTC day', async () => {
    let now = Date.UTC(2030, 0, 1, 10, 0, 0);
    const budget = new DailyBudget(ctx.db, 1000, () => now);
    expect(await budget.status()).toMatchObject({
      enabled: true,
      exhausted: false,
      usedToday: 0,
      dailyBudget: 1000,
    });

    expect(await budget.spend(400)).toBe(false);
    expect(await budget.spend(400)).toBe(false);
    expect((await budget.status()).usedToday).toBe(800);
    expect(await budget.spend(250)).toBe(true); // crosses the line
    expect(await budget.isExhausted()).toBe(true);
    expect((await budget.status()).resetsAt).toBe('2030-01-02T00:00:00.000Z');

    // A new instance (a restart) sees the same spending: it is not held in memory.
    expect(await new DailyBudget(ctx.db, 1000, () => now).isExhausted()).toBe(true);

    now = Date.UTC(2030, 0, 2, 0, 0, 1);
    expect(await budget.isExhausted()).toBe(false);
    expect((await budget.status()).usedToday).toBe(0);
  });

  it('is off when the budget is 0', async () => {
    const budget = new DailyBudget(ctx.db, 0, () => Date.UTC(2031, 0, 1));
    await budget.spend(10_000_000);
    expect(await budget.status()).toMatchObject({ enabled: false, exhausted: false });
  });
});

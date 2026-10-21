import { describe, expect, it } from 'vitest';
import { checkKey, InvalidKeyFormat, KEY_HEADER, keyFromHeaders, mask } from '../../src/ai/keys.js';
import { LlmError } from '../../src/ai/llm.js';
import { cleanRewriteOutput, MODES, modeById, wordSequence } from '../../src/ai/modes.js';
import {
  formatSources,
  normalizeUrl,
  sanitizeClaim,
  stripInvisible,
} from '../../src/ai/sanitize.js';
import {
  emptyBook,
  fmtDuration,
  limitKind,
  parseDuration,
  parseLimits,
  retryAfterSeconds,
  SharedUsage,
  usageView,
  withHeaders,
  withNotice,
} from '../../src/ai/usage.js';
import { htmlToText } from '../../src/ai/web/html.js';
import { FakeLlm } from './fakes.js';

describe('usage: provider rate-limit headers', () => {
  it('parses durations in every format Groq sends', () => {
    expect(parseDuration('2m59.56s')).toBeCloseTo(179.56);
    expect(parseDuration('7.66s')).toBeCloseTo(7.66);
    expect(parseDuration('1h2m3s')).toBe(3723);
    expect(parseDuration('250ms')).toBeCloseTo(0.25);
    expect(parseDuration('12')).toBe(12);
    for (const bad of ['', 'soon', '-3', undefined, null, '5x'])
      expect(parseDuration(bad)).toBeUndefined();
  });

  it('reads the headers and leaves absent ones undefined', () => {
    const l = parseLimits({
      'X-RateLimit-Limit-Requests': '14400',
      'x-ratelimit-remaining-requests': '14399',
      'x-ratelimit-reset-requests': '6s',
      'x-ratelimit-limit-tokens': '6000',
      'x-ratelimit-remaining-tokens': '5990',
      'x-ratelimit-reset-tokens': '100ms',
    });
    expect(l).toMatchObject({
      requestsLimit: 14400,
      requestsRemaining: 14399,
      tokensLimit: 6000,
      tokensRemaining: 5990,
    });
    expect(parseLimits({})).toEqual({
      requestsLimit: undefined,
      requestsRemaining: undefined,
      requestsResetS: undefined,
      tokensLimit: undefined,
      tokensRemaining: undefined,
      tokensResetS: undefined,
    });
    expect(retryAfterSeconds({ 'retry-after': '17' })).toBe(17);
  });

  it('tells a daily limit from a per-minute one in a 429 message', () => {
    expect(limitKind('Rate limit reached ... on tokens per day (TPD)')).toBe('day');
    expect(limitKind('... requests per minute (RPM) ...')).toBe('minute');
    expect(limitKind('too many requests')).toBeUndefined();
  });

  it('formats durations compactly', () => {
    expect(fmtDuration(0.4)).toBe('under 1 s');
    expect(fmtDuration(45)).toBe('45 s');
    expect(fmtDuration(125)).toBe('2 min 05 s');
    expect(fmtDuration(3900)).toBe('1 h 05 min');
  });

  it('labels each number by what it measures, and never shows a daily token balance', () => {
    const now = 1_000_000;
    const book = withHeaders(
      emptyBook(),
      {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '990',
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '7500',
        'x-ratelimit-reset-tokens': '30s',
      },
      now,
    );
    const view = usageView(false, book, now + 10_000);
    expect(view.heading).toContain('shared server key');
    expect(view.lines.map((l) => l.label)).toEqual([
      'Requests left today',
      'Tokens left this minute',
    ]);
    expect(view.lines[0]!.text).toBe('990 of 1,000');
    expect(view.lines[1]!.text).toBe('7,500 of 8,000 (resets in 20 s)');
    expect(view.note).toContain('daily token limit is not reported');
    expect(usageView(true, book, now).heading).toContain('your own key');
  });

  it('says so when the provider sends no limit headers, and when there is no reading yet', () => {
    expect(usageView(false, withHeaders(emptyBook(), {}, 1), 2).note).toContain('not available');
    expect(usageView(false, emptyBook(), 1).note).toContain('No reading yet');
  });

  it('shows a recent 429 until it clears', () => {
    const book = withNotice(emptyBook(), 'day', 120, 0);
    expect(usageView(false, book, 10_000).warning).toBe(
      'Daily limit reached, resets in 1 min 50 s',
    );
    expect(usageView(false, book, 200_000).warning).toBeUndefined();
  });

  it('refreshes the shared reading at most once per window', () => {
    let t = 1_000_000;
    const shared = new SharedUsage(() => t);
    expect(shared.claimRefresh()).toBe(true);
    expect(shared.claimRefresh()).toBe(false);
    t += 31_000;
    expect(shared.claimRefresh()).toBe(true);
  });
});

describe('keys', () => {
  it('shows at most the last 4 characters, and nothing for short keys', () => {
    expect(mask('gsk_abcdefghijklmnop1234')).toBe('••••1234');
    expect(mask('short-key')).toBe('••••');
    expect(mask(undefined)).toBe('');
  });

  it('reads the key header and rejects things that are not keys', () => {
    expect(keyFromHeaders({ [KEY_HEADER]: '  gsk_abc123  ' })).toBe('gsk_abc123');
    expect(keyFromHeaders({})).toBeUndefined();
    expect(() => keyFromHeaders({ [KEY_HEADER]: 'has space' })).toThrow(InvalidKeyFormat);
    expect(() => keyFromHeaders({ [KEY_HEADER]: 'x'.repeat(400) })).toThrow(InvalidKeyFormat);
    expect(() => keyFromHeaders({ [KEY_HEADER]: 'bad\u0001key' })).toThrow(InvalidKeyFormat);
  });

  it('validates a key with one probe and never puts the key in the answer', async () => {
    const KEY = 'gsk_SECRET_do_not_leak_123456';
    const ok = new FakeLlm(() => 'x');
    ok.probeHeaders = { 'x-ratelimit-remaining-requests': '5' };
    const accepted = await checkKey(ok, KEY);
    expect(accepted).toMatchObject({ accepted: true });
    expect(ok.probes).toEqual([KEY]);

    const cases: [LlmError, boolean][] = [
      [new LlmError('auth', 401), false],
      [new LlmError('not-found', 404), false],
      [new LlmError('network'), false],
      [new LlmError('rate-limit', 429, { 'retry-after': '9' }, 'tokens per minute (TPM)'), true],
    ];
    for (const [err, expectAccepted] of cases) {
      const llm = new FakeLlm(() => 'x');
      llm.probeError = err;
      const r = await checkKey(llm, KEY);
      expect(r.accepted).toBe(expectAccepted);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });
});

describe('modes', () => {
  it('is a registry: adding a mode is adding an entry', () => {
    const ids = MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['grammar', 'reformat', 'expand']));
    for (const m of MODES) {
      expect(m.label && m.description).toBeTruthy();
      expect(['rewrite', 'research']).toContain(m.kind);
      if (m.kind === 'rewrite') expect(m.system).toBeTruthy();
    }
    expect(modeById('grammar')?.kind).toBe('rewrite');
    expect(modeById('expand')?.kind).toBe('research');
    expect(modeById('nope')).toBeUndefined();
  });

  it('grammar rejects an answer that rewrote the text instead of fixing it', () => {
    const grammar = modeById('grammar')!;
    const base = 'Their going to the store tomorow and they dont have no money.';
    expect(
      grammar.check!(base, 'They are going to the store tomorrow and they do not have any money.'),
    ).toBeNull();
    expect(
      grammar.check!(
        base,
        'Shopping trip planned; funds are lacking, so the outing may be cancelled soon.',
      ),
    ).toMatch(/too-many-changes|length-changed/);
    expect(grammar.check!(base, '   ')).toBe('empty-output');
  });

  it('reformat accepts structure changes and rejects any change of content', () => {
    const reformat = modeById('reformat')!;
    const base = '#Title\n* one\n* two\n1) first\n2) second\n\n|a|b|\n|-|-|\n|1|2|';
    const tidy =
      '# Title\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    expect(reformat.check!(base, tidy)).toBeNull();
    expect(reformat.check!(base, tidy.replace('second', 'third'))).toBe('content-changed');
    expect(reformat.check!(base, tidy.replace('- two\n', ''))).toBe('content-changed');
    expect(wordSequence("It's a well-known fact: 3 items.")).toEqual([
      "it's",
      'a',
      'well-known',
      'fact',
      '3',
      'items',
    ]);
  });

  it('strips a code fence and keeps the original spacing at the edges of the range', () => {
    expect(cleanRewriteOutput('```markdown\nHello there.\n```', '  Hello ther.\n')).toBe(
      '  Hello there.\n',
    );
    expect(cleanRewriteOutput('Hi', 'hi')).toBe('Hi');
  });
});

describe('sanitizeClaim: model output is untrusted', () => {
  it('removes images, html, links, bare urls and markdown structure', () => {
    const dirty =
      '# Heading ![x](https://evil.test/p.png?d=SECRET) <img src=https://evil.test/a> <script>alert(1)</script> ' +
      'See [the report](https://evil.test/login) and https://evil.test/x for details. javascript:alert(1)';
    const clean = sanitizeClaim(dirty);
    for (const bad of ['![', '<', 'evil.test', 'http', 'javascript:', ']('])
      expect(clean).not.toContain(bad);
    expect(clean).toContain('the report');
    expect(clean).toContain('for details');
  });

  it('removes control and zero-width characters, collapses whitespace, and bounds the length', () => {
    expect(stripInvisible('a​b\u0000c d﻿e')).toBe('abcde');
    expect(sanitizeClaim('line one\n\n\n  line   two')).toBe('line one line two');
    expect(sanitizeClaim('x'.repeat(5000)).length).toBe(700);
  });

  it('normalises urls for comparison and writes safe source links itself', () => {
    expect(normalizeUrl('HTTPS://Example.com/a/#frag')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a/')).toBe(normalizeUrl('https://example.com/a'));
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(formatSources([{ url: 'https://www.a.com/x(1)', title: 'A' }])).toBe(
      '([a.com](https://www.a.com/x%281%29))',
    );
  });
});

describe('htmlToText: a web page becomes plain text', () => {
  it('drops scripts, styles, comments and markup but keeps the prose', () => {
    const html =
      '<html><head><title>My &amp; Page</title><style>p{color:red}</style></head><body>' +
      '<script>var secret = 1;</script><!-- hidden --><h1>Heading</h1><p>First <b>bold</b> paragraph.</p>' +
      '<noscript>no js</noscript><p>Second&nbsp;one &lt;not a tag&gt;.</p><iframe src="x">frame</iframe></body></html>';
    const { title, text } = htmlToText(html);
    expect(title).toBe('My & Page');
    expect(text).toContain('Heading');
    expect(text).toContain('First bold paragraph.');
    expect(text).toContain('Second one <not a tag>.');
    for (const bad of ['secret', 'color:red', 'hidden', 'no js', 'frame', '<b>'])
      expect(text).not.toContain(bad);
  });

  it('survives unterminated scripts and comments, and bounds the size', () => {
    expect(htmlToText('<p>before</p><script>evil(').text).toBe('before');
    expect(htmlToText('<p>before</p><!-- never closed <p>after</p>').text).toBe('before');
    const big = htmlToText(`<p>${'word '.repeat(10_000)}</p>`, 500);
    expect(big.text.length).toBe(500);
    expect(big.truncated).toBe(true);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyHunks, computeHunks, conflicts, rebaseHunks, type Hunk } from '../../src/ai/hunks.js';

const words = fc.array(
  fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'),
  {
    minLength: 3,
    maxLength: 14,
  },
);
const text = words.map((w) => w.join(' '));

/** Random edits of a base text at word granularity (replace, delete or insert words). */
const mutate = (
  base: string,
  edits: { at: number; kind: 'replace' | 'delete' | 'insert'; w: string }[],
) => {
  const parts = base.split(' ');
  for (const e of edits) {
    const i = e.at % Math.max(1, parts.length);
    if (e.kind === 'replace') parts[i] = e.w;
    else if (e.kind === 'delete') parts.splice(i, 1);
    else parts.splice(i, 0, e.w);
  }
  return parts.join(' ');
};
const edits = fc.array(
  fc.record({
    at: fc.nat(30),
    kind: fc.constantFrom('replace', 'delete', 'insert' as const),
    w: fc.constantFrom('kappa', 'lambda', 'mu', 'nu'),
  }),
  { maxLength: 3 },
);

describe('computeHunks / applyHunks', () => {
  it('applying the hunks to the base always gives the new text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (a, b) => {
        expect(applyHunks(a, computeHunks(a, b))).toBe(b);
      }),
      { numRuns: 400 },
    );
  });

  it('hunks are ordered, non-overlapping and minimal for unchanged text', () => {
    expect(computeHunks('same text', 'same text')).toEqual([]);
    const hunks = computeHunks('the cat sat on the mat', 'the dog sat on the rug');
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < hunks.length; i++)
      expect(hunks[i]!.start).toBeGreaterThanOrEqual(hunks[i - 1]!.end);
  });
});

describe('conflicts', () => {
  const h = (start: number, end: number, insert = 'x'): Hunk => ({ start, end, insert });
  it('treats overlap as a conflict and mere adjacency as independent', () => {
    expect(conflicts(h(2, 5), h(4, 8))).toBe(true);
    expect(conflicts(h(2, 5), h(5, 8))).toBe(false);
    expect(conflicts(h(5, 8), h(2, 5))).toBe(false);
  });
  it('two insertions at the same point are ambiguous, so they conflict', () => {
    expect(conflicts(h(3, 3), h(3, 3))).toBe(true);
    expect(conflicts(h(3, 3), h(4, 4))).toBe(false);
  });
  it("an insertion strictly inside the other side's edit conflicts; at its edge it does not", () => {
    expect(conflicts(h(3, 3), h(1, 6))).toBe(true);
    expect(conflicts(h(1, 6), h(3, 3))).toBe(true);
    expect(conflicts(h(1, 6), h(6, 6))).toBe(false);
    expect(conflicts(h(1, 6), h(1, 1))).toBe(false);
  });
});

describe('rebaseHunks', () => {
  it('returns the hunks unchanged when nothing moved', () => {
    const base = 'one two three';
    const ai = computeHunks(base, 'one 2 three');
    expect(rebaseHunks(base, ai, base)).toEqual({ ok: true, hunks: ai });
  });

  it('moves a hunk past an earlier human insertion', () => {
    const base = 'alpha beta gamma';
    const ai = computeHunks(base, 'alpha beta GAMMA');
    const current = 'NEW alpha beta gamma';
    const r = rebaseHunks(base, ai, current);
    expect(r.ok).toBe(true);
    if (r.ok) expect(applyHunks(current, r.hunks)).toBe('NEW alpha beta GAMMA');
  });

  it('is stale when a person edited the very words the model changed', () => {
    const base = 'alpha beta gamma';
    const ai = computeHunks(base, 'alpha BETA gamma');
    expect(rebaseHunks(base, ai, 'alpha bet gamma')).toEqual({ ok: false, reason: 'overlap' });
  });

  it('is stale when the text was changed too much to trust', () => {
    const base = 'alpha beta gamma delta';
    const ai = computeHunks(base, 'alpha beta gamma DELTA');
    expect(rebaseHunks(base, ai, 'something else entirely different here')).toMatchObject({
      ok: false,
    });
  });

  it('PROPERTY: independent edits merge exactly like applying both change sets to the base', () => {
    fc.assert(
      fc.property(text, edits, edits, (base, aiEdits, humanEdits) => {
        const aiNext = mutate(base, aiEdits);
        const humanNext = mutate(base, humanEdits);
        const ai = computeHunks(base, aiNext);
        const human = computeHunks(base, humanNext);
        const r = rebaseHunks(base, ai, humanNext);

        const collide = ai.some((a) => human.some((hu) => conflicts(a, hu)));
        if (r.ok) {
          expect(collide).toBe(false);
          // Independent oracle: apply the union of both change sets to the base, in position order.
          const union = [...ai, ...human].sort((x, y) => x.start - y.start || x.end - y.end);
          expect(applyHunks(humanNext, r.hunks)).toBe(applyHunks(base, union));
        } else if (r.reason === 'overlap') {
          expect(collide).toBe(true);
        }
      }),
      { numRuns: 600 },
    );
  });

  it('PROPERTY: it never reports success for a suggestion that would clobber a human edit', () => {
    fc.assert(
      fc.property(text, edits, edits, (base, aiEdits, humanEdits) => {
        const ai = computeHunks(base, mutate(base, aiEdits));
        const humanNext = mutate(base, humanEdits);
        const r = rebaseHunks(base, ai, humanNext);
        if (!r.ok) return;
        // Every character the humans inserted must still be in the result.
        const merged = applyHunks(humanNext, r.hunks);
        for (const h of computeHunks(base, humanNext)) {
          if (h.insert) expect(merged).toContain(h.insert.trim());
        }
      }),
      { numRuns: 400 },
    );
  });
});

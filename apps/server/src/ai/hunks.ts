import { diffWordsWithSpace } from 'diff';

/**
 * A change expressed against a base text: replace base[start, end) with `insert`.
 * A suggestion is a list of hunks over the text the model was shown (its "base"), so it can be
 * applied later to a document that has moved on, or refused if it can no longer be applied safely.
 */
export interface Hunk {
  start: number;
  end: number;
  insert: string;
}

/** Word-level diff turned into non-overlapping hunks over `base`, in ascending order. */
export function computeHunks(base: string, next: string): Hunk[] {
  if (base === next) return [];
  const hunks: Hunk[] = [];
  let pos = 0;
  let open: Hunk | null = null;
  for (const part of diffWordsWithSpace(base, next)) {
    if (!part.added && !part.removed) {
      if (open) hunks.push(open);
      open = null;
      pos += part.value.length;
      continue;
    }
    open ??= { start: pos, end: pos, insert: '' };
    if (part.removed) {
      pos += part.value.length;
      open.end = pos;
    } else {
      open.insert += part.value;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

/** Applies hunks (ascending, non-overlapping) to `base`. */
export function applyHunks(base: string, hunks: readonly Hunk[]): string {
  let out = '';
  let pos = 0;
  for (const h of hunks) {
    out += base.slice(pos, h.start) + h.insert;
    pos = h.end;
  }
  return out + base.slice(pos);
}

const delta = (h: Hunk): number => h.insert.length - (h.end - h.start);

/**
 * Do two changes to the same base collide? Edits that merely touch (one ends where the other
 * starts) are independent. Two insertions at the same point are ambiguous, so they do collide.
 */
export function conflicts(a: Hunk, h: Hunk): boolean {
  if (a.start === a.end && h.start === h.end) return a.start === h.start;
  if (a.start === a.end) return h.start < a.start && a.start < h.end; // AI insertion inside a human edit
  if (h.start === h.end) return a.start < h.start && h.start < a.end; // human insertion inside an AI edit
  return Math.max(a.start, h.start) < Math.min(a.end, h.end);
}

export type MergeResult =
  { ok: true; hunks: Hunk[] } | { ok: false; reason: 'overlap' | 'too-changed' | 'anchor-lost' };

/** Share of the base text that people may change before a suggestion is considered out of date. */
export const MAX_HUMAN_CHANGE_RATIO = 0.5;

/**
 * Re-bases the AI's hunks (written against `base`) onto `current`, the text now in the anchored
 * range after people kept editing. Succeeds only when every AI hunk can be placed unambiguously;
 * otherwise reports why the suggestion is stale. Never guesses.
 */
export function rebaseHunks(base: string, aiHunks: readonly Hunk[], current: string): MergeResult {
  if (base === current) return { ok: true, hunks: aiHunks.map((h) => ({ ...h })) };
  const human = computeHunks(base, current);

  const changed = human.reduce((n, h) => n + (h.end - h.start) + h.insert.length, 0);
  if (changed > Math.max(1, base.length) * MAX_HUMAN_CHANGE_RATIO) {
    return { ok: false, reason: 'too-changed' };
  }

  const out: Hunk[] = [];
  for (const a of aiHunks) {
    if (human.some((h) => conflicts(a, h))) return { ok: false, reason: 'overlap' };
    // Everything people changed entirely before this hunk moves it; the hunk itself keeps its length.
    const shift = human.filter((h) => h.end <= a.start).reduce((n, h) => n + delta(h), 0);
    out.push({ start: a.start + shift, end: a.end + shift, insert: a.insert });
  }
  return { ok: true, hunks: out };
}

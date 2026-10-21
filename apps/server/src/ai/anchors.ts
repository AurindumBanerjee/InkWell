import * as Y from 'yjs';

/**
 * Suggestions point at text with Yjs relative positions, not character offsets. A relative
 * position names the character it sits next to, so it keeps pointing at the same text while other
 * people insert and delete around it (including edits that arrive late from offline users).
 */

export const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const fromB64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

export const TEXT_KEY = 'content';

/**
 * Anchor at `index`. `assoc` -1 sticks to the character BEFORE the position, +1 (the default) to
 * the one after. A range start uses +1 and a range end uses -1, so text typed right at either edge
 * lands outside the range instead of silently extending it.
 */
export function anchorAt(text: Y.Text, index: number, assoc: 1 | -1): string {
  return toB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)));
}

export function resolveAnchor(doc: Y.Doc, b64: string): number | null {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromB64(b64)),
      doc,
    );
    return abs ? abs.index : null;
  } catch {
    return null;
  }
}

export interface Range {
  from: number;
  to: number;
}

/** The current absolute range between two anchors, or null if either no longer resolves. */
export function resolveRange(doc: Y.Doc, startB64: string, endB64: string): Range | null {
  const from = resolveAnchor(doc, startB64);
  const to = resolveAnchor(doc, endB64);
  if (from === null || to === null || to < from) return null;
  const len = doc.getText(TEXT_KEY).length;
  return { from: Math.min(from, len), to: Math.min(to, len) };
}

/** Anchors for a range of the live document (start sticks right, end sticks left). */
export function anchorRange(
  text: Y.Text,
  from: number,
  to: number,
): { start: string; end: string } {
  return { start: anchorAt(text, from, 1), end: anchorAt(text, to, -1) };
}

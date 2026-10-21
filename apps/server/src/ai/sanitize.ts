import type { Source } from './suggestions.js';

/**
 * Text the model writes for the document is untrusted output: it may have been steered by a
 * hostile web page. These helpers make sure it can carry no surprise into the document: no images
 * (a rendered image URL can leak data), no HTML, no links except the verified sources the SERVER
 * appends, and no control characters.
 */

/** Canonical form for comparing URLs: no fragment, no default port, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Control and invisible code points (C0 controls, zero-width marks, line/paragraph separators, BOM). */
const INVISIBLE: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0xfeff, 0xfeff],
];

export function stripInvisible(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (!INVISIBLE.some(([a, b]) => c >= a && c <= b)) out += ch;
  }
  return out;
}

/** One plain paragraph: links reduced to their labels, images/HTML/URLs/control characters removed. */
export function sanitizeClaim(text: string, maxChars = 700): string {
  return stripInvisible(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images, with or without alt text
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/<\/?[a-zA-Z!][^>]*>?/g, '') // HTML tags and comments
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // inline links keep only their label
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference links likewise
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '') // reference definitions
    .replace(/\b(?:https?|ftp|data|javascript):[^\s)>\]]+/gi, '') // bare URLs
    .replace(/^[\s>#*\-+|`]+/, '') // no heading/list/quote/table/code markers at the start
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

const label = (u: string): string => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return 'source';
  }
};

/** Markdown-safe URL: only the characters that could end the link early are encoded. */
const mdUrl = (u: string): string =>
  u.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'));

/** "([a.com](https://a.com/x), [b.org](https://b.org/y))": links the SERVER vouches for. */
export function formatSources(sources: readonly Source[]): string {
  return `(${sources.map((s) => `[${label(s.url)}](${mdUrl(s.url)})`).join(', ')})`;
}

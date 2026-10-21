import { stripInvisible } from '../sanitize.js';

/**
 * Turns an untrusted web page into plain text for the model. The output is only ever read as text:
 * it is never rendered, so the goal is to drop everything that is not readable content (scripts,
 * styles, markup) and to bound the size, not to produce safe HTML.
 */

const DROP_BLOCKS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
];
const BLOCK_TAGS =
  'address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) &&
        code > 8 &&
        code < 0x110000 &&
        !(code >= 0xd800 && code < 0xe000)
        ? String.fromCodePoint(code)
        : ' ';
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

export interface PageText {
  title: string;
  text: string;
  truncated: boolean;
}

export function htmlToText(html: string, maxChars = 12_000): PageText {
  let h = html;

  const title = decodeEntities(/<title[^>]*>([\s\S]*?)(?:<\/title\s*>|$)/i.exec(h)?.[1] ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  // Comments first (an unterminated one swallows the rest, as a browser would), then whole blocks
  // whose contents are never prose. An unterminated <script> also runs to the end of the page.
  h = h.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  for (const tag of DROP_BLOCKS) {
    h = h.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), ' ');
  }
  h = h.replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, ' ');

  // Block-level tags become line breaks so paragraphs stay separate; every other tag goes.
  h = h.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  h = h.replace(/<[^>]*>?/g, ' '); // also removes a dangling "<tag attr" at the end

  const text = stripInvisible(decodeEntities(h))
    .replace(/[^\S\n]+/g, ' ') // any whitespace except newline, including tabs and non-breaking spaces
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > maxChars
    ? { title, text: text.slice(0, maxChars), truncated: true }
    : { title, text, truncated: false };
}

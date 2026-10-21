import { LlmError, type LlmClient } from './llm.js';
import { emptyBook, retryAfterSeconds, withHeaders, withNotice, type UsageBook } from './usage.js';

/**
 * A user's own API key lives in their browser session and travels in a request header, one request
 * at a time. The server never stores it, never writes it to the database, a cache, a log or an
 * error report, and never returns it: at most the last 4 characters are shown, by the browser.
 */

/** '••••abcd'. Keys shorter than 12 characters reveal nothing at all. */
export function mask(key: string | undefined): string {
  if (!key) return '';
  return key.length >= 12 ? `••••${key.slice(-4)}` : '••••';
}

/** The request header the browser sends a user's own key in. */
export const KEY_HEADER = 'x-ai-key';

/** Reads and sanity-checks the key header. Returns undefined if absent; throws on junk. */
export function keyFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers[KEY_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return undefined;
  // Printable ASCII only, bounded length: anything else is not an API key.
  if (value.length > 300 || !/^[\x21-\x7e]+$/.test(value)) throw new InvalidKeyFormat();
  return value;
}

export class InvalidKeyFormat extends Error {
  constructor() {
    super('That does not look like an API key.');
  }
}

export interface KeyCheck {
  accepted: boolean;
  /** Status line for the UI. Never contains the key. */
  message: string;
  book?: UsageBook;
}

/** Validates a pasted key with one cheap call and reads its limits. The key is not retained. */
export async function checkKey(llm: LlmClient, key: string, now = Date.now()): Promise<KeyCheck> {
  try {
    const headers = await llm.probe(key);
    return {
      accepted: true,
      message: 'Key accepted.',
      book: withHeaders(emptyBook(), headers, now),
    };
  } catch (err) {
    if (err instanceof LlmError) {
      if (err.kind === 'auth') return { accepted: false, message: 'Key rejected by the provider.' };
      if (err.kind === 'not-found') {
        return {
          accepted: false,
          message: 'The provider accepted the key but not the model this app uses.',
        };
      }
      if (err.kind === 'rate-limit') {
        return {
          accepted: true,
          message: 'Key accepted, but it is rate-limited right now.',
          book: withNotice(emptyBook(), err.limit, retryAfterSeconds(err.headers), now),
        };
      }
    }
    return { accepted: false, message: 'Could not check the key right now (connection problem).' };
  }
}

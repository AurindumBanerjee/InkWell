import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { htmlToText } from './html.js';

/**
 * Fetching a page for the agent, hardened against SSRF. The URL comes from a search result, which
 * is attacker-influenced text, so every step assumes hostility:
 *   - http/https only, standard ports, no credentials in the URL;
 *   - the host is resolved ONCE, every returned address must be public, and the connection goes to
 *     that exact address (so DNS cannot answer "public" for the check and "private" for the connect);
 *   - redirects are followed by hand, a few at most, and each hop is checked from scratch;
 *   - total time and body size are capped, compression is refused, only text content is accepted.
 */

export type BlockReason =
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'host'
  | 'private-address'
  | 'dns'
  | 'redirects'
  | 'status'
  | 'content-type'
  | 'timeout'
  | 'network';

/** Carries a reason code only: nothing about internal hosts or addresses is revealed to the model. */
export class FetchBlocked extends Error {
  constructor(readonly reason: BlockReason) {
    super(`fetch blocked: ${reason}`);
    this.name = 'FetchBlocked';
  }
}

// ---------------------------------------------------------------- address classification

const v4ToInt = (ip: string): number | null => {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
};

const inV4 = (n: number, base: string, bits: number): boolean => {
  const b = v4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === (b & mask) >>> 0;
};

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function v6ToBytes(ip: string): Uint8Array | null {
  if (ip.includes('%')) return null; // zone ids are never public
  let s = ip.toLowerCase();
  // Embedded dotted quad (::ffff:1.2.3.4): convert the tail to two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    if (n === null) return null;
    s =
      s.slice(0, -dotted[1]!.length) +
      ((n >>> 16) & 0xffff).toString(16) +
      ':' +
      (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i]!)) return null;
    const v = parseInt(groups[i]!, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

const embeddedV4 = (b: Uint8Array, at: number): string =>
  `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/** True for any address that is not an ordinary public internet address. Unparseable counts as blocked. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return n === null || BLOCKED_V4.some(([base, bits]) => inV4(n, base, bits));
  }
  if (!net.isIPv6(ip)) return true;
  const b = v6ToBytes(ip);
  if (!b) return true;

  const allZeroUntil = (end: number) => b.slice(0, end).every((x) => x === 0);
  if (allZeroUntil(10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIp(embeddedV4(b, 12)); // ::ffff:a.b.c.d
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return isBlockedIp(embeddedV4(b, 12)); // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIp(embeddedV4(b, 2)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0) return true; // ::/8 covers ::, ::1 and the old IPv4-compatible form
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x01 && b[1] === 0 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64 discard
  // Only global unicast 2000::/3 is public.
  return (b[0]! & 0xe0) !== 0x20;
}

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.lan',
  '.intranet',
  '.corp',
];

/** Cheap checks on the textual host before any DNS lookup. */
export function assertPublicHostname(host: string): void {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!h) throw new FetchBlocked('host');
  if (net.isIP(h)) {
    if (isBlockedIp(h)) throw new FetchBlocked('private-address');
    return;
  }
  if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s)) || !h.includes('.')) {
    throw new FetchBlocked('host');
  }
}

// ---------------------------------------------------------------- transport and resolution

export interface Resolved {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<Resolved[]>;

export interface TransportRequest {
  url: URL;
  /** The already-vetted address to connect to. */
  ip: string;
  family: 4 | 6;
  signal: AbortSignal;
  maxBytes: number;
  userAgent: string;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
  truncated: boolean;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

const defaultResolver: Resolver = async (hostname) => {
  const rows = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Connects to `ip` (not the hostname), sending the hostname for Host and TLS SNI/verification. */
export const nodeTransport: Transport = ({ url, ip, family, signal, maxBytes, userAgent }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        host: ip,
        family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: url.hostname,
        headers: {
          host: url.host,
          'user-agent': userAgent,
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity', // no compression: nothing to inflate into a bomb
          connection: 'close',
        },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            truncated = true;
            res.destroy();
          } else chunks.push(c);
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
            ),
            body: Buffer.concat(chunks),
            truncated,
          });
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => (truncated ? done() : reject(new FetchBlocked('network'))));
      },
    );
    req.on('error', () =>
      reject(signal.aborted ? new FetchBlocked('timeout') : new FetchBlocked('network')),
    );
    req.end();
  });

// ---------------------------------------------------------------- fetchPage

export interface FetchOptions {
  maxBytes?: number;
  maxChars?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  resolve?: Resolver;
  transport?: Transport;
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

const ALLOWED_PORTS = new Set(['', '80', '443']);

function vet(raw: string): URL {
  if (raw.length > 2000) throw new FetchBlocked('host');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlocked('host');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchBlocked('scheme');
  if (url.username || url.password) throw new FetchBlocked('credentials');
  if (!ALLOWED_PORTS.has(url.port)) throw new FetchBlocked('port');
  assertPublicHostname(url.hostname); // WHATWG parsing already turned 2130706433 / 0x7f.1 into 127.0.0.1
  return url;
}

export async function fetchPage(rawUrl: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const resolve = opts.resolve ?? defaultResolver;
  const transport = opts.transport ?? nodeTransport;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const raced = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        signal.addEventListener('abort', () => rej(new FetchBlocked('timeout')), { once: true }),
      ),
    ]);

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = vet(current);

    let addrs: Resolved[];
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      addrs = [{ address: literal, family: net.isIPv6(literal) ? 6 : 4 }];
    } else {
      try {
        addrs = await raced(resolve(url.hostname));
      } catch (err) {
        if (err instanceof FetchBlocked) throw err;
        throw new FetchBlocked('dns');
      }
    }
    if (addrs.length === 0) throw new FetchBlocked('dns');
    // Strict: if ANY answer is private the host is refused, so a mixed answer cannot be used to
    // slip a private address through.
    if (addrs.some((a) => isBlockedIp(a.address))) throw new FetchBlocked('private-address');

    const pick = addrs[0]!;
    const res = await raced(
      transport({
        url,
        ip: pick.address,
        family: pick.family,
        signal,
        maxBytes,
        userAgent: opts.userAgent ?? 'InkwellResearchBot/1.0',
      }),
    );

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      try {
        current = new URL(res.headers.location, url).toString();
      } catch {
        throw new FetchBlocked('host');
      }
      continue; // the next loop iteration vets the new URL from scratch
    }
    if (res.status !== 200) throw new FetchBlocked('status');

    const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const isHtml = type === 'text/html' || type === 'application/xhtml+xml';
    if (!isHtml && type !== 'text/plain') throw new FetchBlocked('content-type');

    const raw = new TextDecoder('utf-8', { fatal: false }).decode(res.body);
    const page = isHtml
      ? htmlToText(raw, opts.maxChars ?? 12_000)
      : {
          title: '',
          text: raw
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, opts.maxChars ?? 12_000),
          truncated: raw.length > (opts.maxChars ?? 12_000),
        };
    return {
      url: url.toString(),
      title: page.title,
      text: page.text,
      truncated: page.truncated || res.truncated,
    };
  }
  throw new FetchBlocked('redirects');
}

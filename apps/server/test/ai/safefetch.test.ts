import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertPublicHostname,
  fetchPage,
  FetchBlocked,
  isBlockedIp,
  type Resolver,
  type Transport,
  type TransportResponse,
} from '../../src/ai/web/safeFetch.js';

describe('isBlockedIp: anything that is not an ordinary public address', () => {
  it.each([
    // IPv4: loopback, private, link-local (cloud metadata), CGNAT, reserved
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.1',
    // IPv6: loopback, unspecified, unique-local, link-local, multicast, documentation
    '::1',
    '::',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '100::1',
    // IPv6 forms that smuggle an IPv4 address
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::1',
    '::127.0.0.1',
    // not an address at all
    'not-an-ip',
    '',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4009::200e',
    '::ffff:8.8.8.8',
  ])('allows public address %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('assertPublicHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    'printer.local',
    'db.internal',
    'intranet',
    'nas.lan',
    'x.home.arpa',
    '',
  ])('refuses %s', (host) => expect(() => assertPublicHostname(host)).toThrow(FetchBlocked));
  it('refuses private IP literals, bracketed or not, and allows public hosts', () => {
    expect(() => assertPublicHostname('10.1.2.3')).toThrow(FetchBlocked);
    expect(() => assertPublicHostname('[::1]')).toThrow(FetchBlocked);
    expect(() => assertPublicHostname('example.com')).not.toThrow();
    expect(() => assertPublicHostname('8.8.8.8')).not.toThrow();
  });
});

// ---- fetchPage with a scripted network ------------------------------------------------------------

const PUBLIC = [{ address: '93.184.216.34', family: 4 as const }];
const html = (body: string, extra: Partial<TransportResponse> = {}): TransportResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: new TextEncoder().encode(body),
  truncated: false,
  ...extra,
});

/** A network that resolves every name to a public address and serves scripted responses by host. */
function network(routes: Record<string, TransportResponse | ((url: URL) => TransportResponse)>) {
  const connected: { host: string; ip: string }[] = [];
  const resolved: string[] = [];
  const resolve: Resolver = async (host) => {
    resolved.push(host);
    return PUBLIC;
  };
  const transport: Transport = async ({ url, ip }) => {
    connected.push({ host: url.hostname, ip });
    const r = routes[url.hostname];
    if (!r) throw new FetchBlocked('network');
    return typeof r === 'function' ? r(url) : r;
  };
  return { resolve, transport, connected, resolved };
}
const blockedReason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'allowed';
  } catch (e) {
    return e instanceof FetchBlocked ? e.reason : `other:${String(e)}`;
  }
};

describe('fetchPage: URL and address rules', () => {
  it('refuses non-http schemes, credentials in the URL and unusual ports before any lookup', async () => {
    const net = network({});
    for (const [url, reason] of [
      ['file:///etc/passwd', 'scheme'],
      ['ftp://example.com/x', 'scheme'],
      ['gopher://example.com', 'scheme'],
      ['https://user:pass@example.com/', 'credentials'],
      ['http://example.com:8080/', 'port'],
      ['http://example.com:22/', 'port'],
      ['not a url', 'host'],
      ['https://localhost/', 'host'],
      ['http://169.254.169.254/latest/meta-data/', 'private-address'],
      ['http://[::1]/', 'private-address'],
    ] as const) {
      expect(await blockedReason(fetchPage(url, net))).toBe(reason);
    }
    expect(net.resolved).toEqual([]); // none of these ever reached DNS
    expect(net.connected).toEqual([]);
  });

  it('sees through the odd spellings of loopback: decimal, hex, octal and short forms', async () => {
    const net = network({});
    for (const url of [
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://0/',
    ]) {
      expect(await blockedReason(fetchPage(url, net)), url).toBe('private-address');
    }
    expect(net.connected).toEqual([]);
  });

  it('refuses a host if ANY of its addresses is private, even when others are public', async () => {
    const net = network({ 'example.com': html('hi') });
    const mixed: Resolver = async () => [PUBLIC[0]!, { address: '10.0.0.7', family: 4 }];
    expect(await blockedReason(fetchPage('https://example.com/', { ...net, resolve: mixed }))).toBe(
      'private-address',
    );
    expect(net.connected).toEqual([]);
  });

  it('connects to the address it checked, not to a fresh lookup (no DNS rebinding)', async () => {
    const net = network({ 'example.com': html('<p>ok</p>') });
    let lookups = 0;
    const resolve: Resolver = async () => {
      lookups++;
      // First answer is public; any later lookup would answer "private". It must never be asked twice.
      return lookups === 1 ? PUBLIC : [{ address: '127.0.0.1', family: 4 }];
    };
    const page = await fetchPage('https://example.com/', { ...net, resolve });
    expect(page.text).toBe('ok');
    expect(lookups).toBe(1);
    expect(net.connected).toEqual([{ host: 'example.com', ip: '93.184.216.34' }]);
  });
});

describe('fetchPage: redirects', () => {
  it('follows a redirect between public hosts and reports the final URL', async () => {
    const net = network({
      'a.example': {
        status: 301,
        headers: { location: 'https://b.example/final' },
        body: new Uint8Array(),
        truncated: false,
      },
      'b.example': html('<p>landed</p>'),
    });
    const page = await fetchPage('https://a.example/start', net);
    expect(page.url).toBe('https://b.example/final');
    expect(page.text).toBe('landed');
  });

  it('re-checks every hop: a public page redirecting to a private address is refused', async () => {
    for (const target of [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
      'http://[::1]:80/',
      'file:///etc/passwd',
      'http://10.0.0.1/',
    ]) {
      const net = network({
        'a.example': {
          status: 302,
          headers: { location: target },
          body: new Uint8Array(),
          truncated: false,
        },
      });
      const reason = await blockedReason(fetchPage('https://a.example/', net));
      expect(['private-address', 'host', 'scheme'], target).toContain(reason);
      expect(net.connected.map((c) => c.host)).toEqual(['a.example']); // never connected to the target
    }
  });

  it('a hostname that RESOLVES to a private address at the second hop is refused too', async () => {
    const net = network({
      'a.example': {
        status: 302,
        headers: { location: 'https://sneaky.example/' },
        body: new Uint8Array(),
        truncated: false,
      },
      'sneaky.example': html('secret'),
    });
    const resolve: Resolver = async (host) =>
      host === 'sneaky.example' ? [{ address: '192.168.0.10', family: 4 }] : PUBLIC;
    expect(await blockedReason(fetchPage('https://a.example/', { ...net, resolve }))).toBe(
      'private-address',
    );
    expect(net.connected.map((c) => c.host)).toEqual(['a.example']);
  });

  it('gives up after a few redirects', async () => {
    const net = network({
      'loop.example': (u) => ({
        status: 302,
        headers: { location: `https://loop.example/${u.pathname.length}x` },
        body: new Uint8Array(),
        truncated: false,
      }),
    });
    expect(
      await blockedReason(fetchPage('https://loop.example/', { ...net, maxRedirects: 3 })),
    ).toBe('redirects');
    expect(net.connected).toHaveLength(4); // the original request plus three redirects
  });
});

describe('fetchPage: what it accepts', () => {
  it('accepts only text content types and status 200', async () => {
    for (const [headers, status, reason] of [
      [{ 'content-type': 'application/octet-stream' }, 200, 'content-type'],
      [{ 'content-type': 'application/pdf' }, 200, 'content-type'],
      [{ 'content-type': 'image/png' }, 200, 'content-type'],
      [{}, 200, 'content-type'],
      [{ 'content-type': 'text/html' }, 404, 'status'],
      [{ 'content-type': 'text/html' }, 500, 'status'],
    ] as const) {
      const net = network({
        'x.example': { status, headers, body: new TextEncoder().encode('data'), truncated: false },
      });
      expect(await blockedReason(fetchPage('https://x.example/', net))).toBe(reason);
    }
  });

  it('strips scripts from HTML and passes plain text through', async () => {
    const net = network({
      'h.example': html('<script>steal()</script><p>Readable text</p>'),
      't.example': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: new TextEncoder().encode('plain   words'),
        truncated: false,
      },
    });
    expect((await fetchPage('https://h.example/', net)).text).toBe('Readable text');
    expect((await fetchPage('https://t.example/', net)).text).toBe('plain words');
  });

  it('caps the text it returns and says when the page was cut off', async () => {
    const net = network({
      'big.example': html(`<p>${'a '.repeat(50_000)}</p>`, { truncated: true }),
    });
    const page = await fetchPage('https://big.example/', { ...net, maxChars: 1000 });
    expect(page.text.length).toBe(1000);
    expect(page.truncated).toBe(true);
  });

  it('stops waiting for a server that never answers', async () => {
    const hang: Transport = () => new Promise(() => undefined);
    const started = Date.now();
    expect(
      await blockedReason(
        fetchPage('https://slow.example/', {
          resolve: async () => PUBLIC,
          transport: hang,
          timeoutMs: 80,
        }),
      ),
    ).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('turns a DNS failure into a plain blocked reason, without detail', async () => {
    const resolve: Resolver = async () => {
      throw new Error('ENOTFOUND secret.internal.corp');
    };
    const err = await fetchPage('https://nope.example/', { resolve }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FetchBlocked);
    expect((err as FetchBlocked).reason).toBe('dns');
    expect((err as FetchBlocked).message).not.toContain('corp');
  });
});

// ---- the real default network path against a real local server --------------------------------------

describe('fetchPage with the real default transport', () => {
  let server: http.Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.setHeader('content-type', 'text/html');
      res.end('<p>internal secret</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('never reaches a server on the loopback address, by IP or by name', async () => {
    for (const url of [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
      `http://[::1]:${port}/`,
    ]) {
      expect(['port', 'private-address', 'host'], url).toContain(
        await blockedReason(fetchPage(url)),
      );
    }
    // Even on the standard port the address check stops it before any connection is made.
    expect(await blockedReason(fetchPage('http://127.0.0.1/'))).toBe('private-address');
    expect(hits).toBe(0);
  });
});

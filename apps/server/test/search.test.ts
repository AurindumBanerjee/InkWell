import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HIT_END, HIT_START, reindexAll } from '../src/search.js';
import { Client, setupApp, type TestCtx } from './helpers.js';
import { Peer } from './ws-peer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Hit {
  id: string;
  title: string;
  snippet: string;
  rank: number;
}

describe('full-text search', () => {
  let ctx: TestCtx;
  let base: string;
  let owner: Client, member: Client, sharee: Client, outsider: Client;
  let wsId: string;
  const peers: Peer[] = [];

  const search = async (c: Client, q: string, extra = ''): Promise<Hit[]> => {
    const res = await c.req('GET', `/search?q=${encodeURIComponent(q)}${extra}`);
    expect(res.statusCode).toBe(200);
    return res.json().results;
  };
  const newDoc = async (title: string, body: string, workspace = wsId): Promise<string> => {
    const id: string = (
      await owner.req('POST', `/workspaces/${workspace}/documents`, { title })
    ).json().document.id;
    if (body) {
      const p = await Peer.connect(`${base}/ws/docs/${id}`, { cookie: owner.cookie });
      peers.push(p);
      p.text.insert(0, body);
      await sleep(30);
    }
    return id;
  };
  const closePeers = async () => {
    await Promise.all(peers.splice(0).map((p) => p.close()));
    await sleep(150);
  };
  /** Polls until the query returns the document (indexing is asynchronous by design). */
  const eventually = async (c: Client, q: string, id: string, present = true) => {
    const start = Date.now();
    for (;;) {
      const found = (await search(c, q)).some((h) => h.id === id);
      if (found === present) return;
      if (Date.now() - start > 5000)
        throw new Error(`"${q}" never ${present ? 'found' : 'dropped'} ${id}`);
      await sleep(30);
    }
  };

  beforeAll(async () => {
    ctx = await setupApp({
      sync: { flushMs: 10, indexMs: 20, reauthMs: 60_000, versionGapMs: 3_600_000 },
    });
    base = await ctx.listen();
    owner = await new Client(ctx.app).login('owner@example.com');
    member = await new Client(ctx.app).login('member@example.com');
    sharee = await new Client(ctx.app).login('sharee@example.com');
    outsider = await new Client(ctx.app).login('outsider@example.com');
    wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
    await owner.req('PUT', `/workspaces/${wsId}/members`, {
      email: 'member@example.com',
      role: 'viewer',
    });
  });
  afterEach(closePeers);
  afterAll(() => ctx.close());

  it('finds documents by body text, with the matched terms marked in the snippet', async () => {
    const id = await newDoc('Animals', 'The quick brown fox jumps over the lazy dog');
    await eventually(owner, 'fox', id);
    const [hit] = (await search(owner, 'fox')).filter((h) => h.id === id);
    expect(hit!.snippet).toContain(`${HIT_START}fox${HIT_END}`);
    expect(hit!.title).toBe('Animals');
  });

  it('supports phrases, exclusion, alternatives and stemming', async () => {
    const a = await newDoc('A', 'the lazy dog sleeps while the quick fox runs');
    const b = await newDoc('B', 'a lazy cat and a quick fox');
    await eventually(owner, 'lazy', b);
    await eventually(owner, 'lazy', a);

    const ids = async (q: string) => new Set((await search(owner, q)).map((h) => h.id));
    expect((await ids('"lazy dog"')).has(a)).toBe(true);
    expect((await ids('"lazy dog"')).has(b)).toBe(false);
    expect((await ids('fox -cat')).has(a)).toBe(true);
    expect((await ids('fox -cat')).has(b)).toBe(false);
    const either = await ids('dog or cat');
    expect(either.has(a) && either.has(b)).toBe(true);
    // stemming: "running" matches "runs", "sleeping" matches "sleeps"
    expect((await ids('running')).has(a)).toBe(true);
    expect((await ids('sleeping')).has(a)).toBe(true);
  });

  it('ranks title matches above body-only matches', async () => {
    const inTitle = await newDoc('Quarterly report', 'alpha beta gamma');
    const inBody = await newDoc('Meeting notes', 'we reviewed the quarterly numbers today');
    await eventually(owner, 'quarterly', inBody);
    const order = (await search(owner, 'quarterly')).map((h) => h.id);
    expect(order.indexOf(inTitle)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(inTitle)).toBeLessThan(order.indexOf(inBody));
  });

  it('picks up edits and deletions, and renames', async () => {
    const id = await newDoc('Draft', 'initial content about walruses');
    await eventually(owner, 'walruses', id);

    peers[peers.length - 1]!.text.insert(0, 'marmots ');
    await eventually(owner, 'marmots', id);

    const text = peers[peers.length - 1]!.text;
    text.delete(0, text.length);
    await eventually(owner, 'walruses', id, false);
    await eventually(owner, 'marmots', id, false);

    expect(
      (await owner.req('PATCH', `/documents/${id}`, { title: 'Pangolin handbook' })).statusCode,
    ).toBe(200);
    await eventually(owner, 'pangolin', id);
  });

  it('only returns documents the caller can open, and never leaks their text', async () => {
    const secret = await newDoc('Private plans', 'the zebrafish project is confidential');
    await eventually(owner, 'zebrafish', secret);

    // workspace viewer: allowed (membership); outsider and not-yet-shared user: nothing
    expect((await search(member, 'zebrafish')).map((h) => h.id)).toContain(secret);
    expect(await search(outsider, 'zebrafish')).toEqual([]);
    expect(await search(sharee, 'zebrafish')).toEqual([]);
    expect(await search(outsider, 'confidential')).toEqual([]);
    expect(await search(outsider, 'Private plans')).toEqual([]);

    // direct share grants access, revoking removes it again
    await owner.req('PUT', `/documents/${secret}/shares`, {
      email: 'sharee@example.com',
      role: 'viewer',
    });
    expect((await search(sharee, 'zebrafish')).map((h) => h.id)).toContain(secret);
    const shareId = (await owner.req('GET', `/documents/${secret}/shares`)).json().shares[0].id;
    await owner.req('DELETE', `/documents/${secret}/shares/${shareId}`);
    expect(await search(sharee, 'zebrafish')).toEqual([]);

    // soft-deleted documents vanish for everyone
    await owner.req('DELETE', `/documents/${secret}`);
    expect(await search(owner, 'zebrafish')).toEqual([]);
    expect(await search(member, 'zebrafish')).toEqual([]);
  });

  it('can be restricted to a workspace', async () => {
    const other: string = (await owner.req('POST', '/workspaces', { name: 'Other' })).json()
      .workspace.id;
    const inOther = await newDoc('Elsewhere', 'the narwhal expedition', other);
    const inMain = await newDoc('Here', 'the narwhal habitat');
    await eventually(owner, 'narwhal', inOther);
    await eventually(owner, 'narwhal', inMain);
    const scoped = (await search(owner, 'narwhal', `&workspaceId=${other}`)).map((h) => h.id);
    expect(scoped).toEqual([inOther]);
  });

  it('paginates results', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push(await newDoc(`P${i}`, 'pagination keyword'));
    for (const id of created) await eventually(owner, 'pagination', id);
    const pages = [
      await search(owner, 'pagination', '&limit=2&offset=0'),
      await search(owner, 'pagination', '&limit=2&offset=2'),
      await search(owner, 'pagination', '&limit=2&offset=4'),
    ];
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    const all = pages.flat().map((h) => h.id);
    expect(new Set(all).size).toBe(5);
  });

  it('validates input and is safe against hostile queries', async () => {
    expect((await owner.req('GET', '/search?q=')).statusCode).toBe(400);
    expect((await owner.req('GET', '/search')).statusCode).toBe(400);
    expect((await owner.req('GET', `/search?q=${'a'.repeat(201)}`)).statusCode).toBe(400);
    expect((await owner.req('GET', '/search?q=x&limit=1000')).statusCode).toBe(400);
    expect((await owner.req('GET', '/search?q=x&workspaceId=nope')).statusCode).toBe(400);
    const anon = await ctx.app.inject({ method: 'GET', url: '/search?q=x' });
    expect(anon.statusCode).toBe(401);

    // stop-words only, punctuation soup, and SQL metacharacters: no error, no results, no damage
    for (const q of ['the', "'; DROP TABLE documents; --", '& | ! ( ) : *', '"unterminated']) {
      const res = await owner.req('GET', `/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode, q).toBe(200);
      expect(res.json().results, q).toEqual([]);
    }
    expect((await owner.req('GET', `/workspaces/${wsId}/documents`)).statusCode).toBe(200);
  });

  it('can rebuild the whole index from the persisted documents', async () => {
    const id = await newDoc('Rebuildable', 'content about capybaras');
    await eventually(owner, 'capybaras', id);
    await closePeers(); // everything is persisted as CRDT state now

    await ctx.db.query("UPDATE document_search SET body = '' WHERE document_id = $1", [id]);
    await eventually(owner, 'capybaras', id, false); // index wiped

    expect(await reindexAll(ctx.db)).toBeGreaterThanOrEqual(1);
    await eventually(owner, 'capybaras', id);
  });

  it('is backed by a GIN index the planner can use', async () => {
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        "EXPLAIN SELECT 1 FROM document_search WHERE tsv @@ websearch_to_tsquery('english', 'fox')",
      );
      await client.query('ROLLBACK');
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('document_search_tsv_idx');
    } finally {
      client.release();
    }
  });
});

describe('search indexing on room close', () => {
  it('makes the final text searchable as soon as the last editor leaves, without waiting for the timer', async () => {
    const ctx = await setupApp({
      sync: { flushMs: 10, indexMs: 600_000, reauthMs: 60_000, versionGapMs: 3_600_000 },
    });
    try {
      const base = await ctx.listen();
      const owner = await new Client(ctx.app).login('owner@example.com');
      const wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
      const id = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
      const p = await Peer.connect(`${base}/ws/docs/${id}`, { cookie: owner.cookie });
      p.text.insert(0, 'ephemeral aardvark');
      await sleep(100);
      // the 10-minute timer has not fired, so nothing is indexed yet
      expect((await owner.req('GET', '/search?q=aardvark')).json().results).toEqual([]);
      await p.close();
      await sleep(300);
      const hits = (await owner.req('GET', '/search?q=aardvark')).json().results;
      expect(hits.map((h: Hit) => h.id)).toEqual([id]);
    } finally {
      await ctx.close();
    }
  });
});

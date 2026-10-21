import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorAt } from '../../src/ai/anchors.js';
import { LlmError } from '../../src/ai/llm.js';
import { MODES, type ModeConfig } from '../../src/ai/modes.js';
import { Client, setupApp, type TestCtx } from '../helpers.js';
import { Peer } from '../ws-peer.js';
import { deferred, documentOf, FakeLlm, FakeSearch, sleep, until, type LlmReply } from './fakes.js';

/**
 * The AI collaborator end to end over real HTTP and WebSockets, with a scripted model: no network,
 * no provider key. Each describe block builds an app configured for the behaviour under test.
 */
const SERVER_KEY = 'gsk_SERVER_key_must_never_appear_0001';
const OWN_KEY = 'gsk_OWN_key_must_never_appear_0002';

interface Rig {
  ctx: TestCtx;
  base: string;
  owner: Client;
  editor: Client;
  viewer: Client;
  outsider: Client;
  llm: FakeLlm;
  setReply: (
    fn: (req: Parameters<FakeLlm['complete']>[0], n: number) => LlmReply | Promise<LlmReply>,
  ) => void;
  docs: string[];
  peers: Peer[];
}

async function rig(
  env: Record<string, string> = {},
  extra: { modes?: ModeConfig[]; logStream?: Writable } = {},
): Promise<Rig> {
  let reply: (
    req: Parameters<FakeLlm['complete']>[0],
    n: number,
  ) => LlmReply | Promise<LlmReply> = (req) => documentOf(req);
  const llm = new FakeLlm((req, n) => reply(req, n));
  const ctx = await setupApp({
    ai: true,
    env: {
      LLM_API_KEY: SERVER_KEY,
      TAVILY_API_KEY: 'tvly-x',
      AI_RATE_PER_MINUTE: '1000',
      AI_RATE_PER_DAY: '10000',
      ...env,
    },
    aiOverrides: { llm, search: new FakeSearch([]), modes: extra.modes },
    logStream: extra.logStream,
    sync: { flushMs: 10, reauthMs: 60_000, versionGapMs: 3_600_000, indexMs: 60_000 },
  });
  const base = await ctx.listen();
  const owner = await new Client(ctx.app).login('owner@example.com', 'Olive');
  const editor = await new Client(ctx.app).login('editor@example.com', 'Eddie');
  const viewer = await new Client(ctx.app).login('viewer@example.com', 'Vera');
  const outsider = await new Client(ctx.app).login('outsider@example.com', 'Otto');
  return {
    ctx,
    base,
    owner,
    editor,
    viewer,
    outsider,
    llm,
    setReply: (f) => (reply = f),
    docs: [],
    peers: [],
  };
}

async function newDoc(r: Rig, text: string): Promise<{ id: string; peer: Peer }> {
  const ws = (await r.owner.req('GET', '/workspaces')).json().workspaces[0].id;
  const id: string = (
    await r.owner.req('POST', `/workspaces/${ws}/documents`, { title: 'Doc' })
  ).json().document.id;
  await r.owner.req('PUT', `/documents/${id}/shares`, {
    email: 'editor@example.com',
    role: 'editor',
  });
  await r.owner.req('PUT', `/documents/${id}/shares`, {
    email: 'viewer@example.com',
    role: 'viewer',
  });
  const peer = await join(r, r.owner, id);
  peer.text.insert(0, text);
  await until(async () => (await r.owner.req('GET', `/documents/${id}`)).statusCode === 200);
  await sleep(60);
  return { id, peer };
}

async function join(r: Rig, c: Client, id: string): Promise<Peer> {
  const p = await Peer.connect(`${r.base}/ws/docs/${id}`, { cookie: c.cookie });
  r.peers.push(p);
  return p;
}

const closeRig = async (r: Rig) => {
  await Promise.all(r.peers.splice(0).map((p) => p.close()));
  await r.ctx.close();
};

/** POST /ai/suggestions, optionally on a selection and/or with the user's own key header. */
const ask = (
  c: Client,
  documentId: string,
  mode: string,
  sel?: { peer: Peer; from: number; to: number },
  key?: string,
) => {
  const body: Record<string, string> = { documentId, mode };
  if (sel) {
    body.anchorStart = anchorAt(sel.peer.text, sel.from, 1);
    body.anchorEnd = anchorAt(sel.peer.text, sel.to, -1);
  }
  return c.rawReq('POST', '/ai/suggestions', body, key ? { 'x-ai-key': key } : {});
};

const status = async (r: Rig, c: Client, id: string) =>
  (await c.req('GET', `/ai/suggestions/${id}`)).json().suggestion as {
    status: string;
    errorCode: string | null;
  };
const settled = (r: Rig, c: Client, id: string) =>
  until(
    async () => {
      const s = await status(r, c, id);
      return s.status !== 'working' ? s : null;
    },
    8000,
    'suggestion to settle',
  );

describe('grammar flow, presence and attribution', () => {
  let r: Rig;
  beforeAll(async () => (r = await rig()));
  afterAll(() => closeRig(r));

  it('works as a Yjs peer: shows "AI assistant" while working, then a suggestion that applies in one transaction', async () => {
    const { id, peer } = await newDoc(r, 'Ths is a tset.');
    const watcher = await join(r, r.editor, id);
    await until(() => watcher.text.toString() === 'Ths is a tset.');

    const hold = deferred<void>();
    r.setReply(async (req) => {
      await hold.promise;
      return documentOf(req).replace('Ths', 'This').replace('tset', 'test');
    });
    const res = await ask(r.owner, id, 'grammar');
    expect(res.statusCode).toBe(202);
    const sid: string = res.json().suggestion.id;

    // While the model works, collaborators see the agent in the presence list, with a cursor.
    const agent = await until(() =>
      [...watcher.awareness.getStates().values()].find(
        (s) => (s as { user?: { name?: string } }).user?.name === 'AI assistant',
      ),
    );
    expect(agent).toMatchObject({ user: { id: 'ai-assistant', name: 'AI assistant' } });
    expect((agent as { cursor?: unknown }).cursor).toBeTruthy();
    expect((await status(r, r.owner, sid)).status).toBe('working');

    hold.resolve();
    const pending = await settled(r, r.owner, sid);
    expect(pending.status).toBe('pending');
    // ...and it is gone again once the run ends.
    await until(
      () =>
        ![...watcher.awareness.getStates().values()].some(
          (s) => (s as { user?: { name?: string } }).user?.name === 'AI assistant',
        ),
    );
    // The model never edits: the document is untouched until someone accepts.
    expect(peer.text.toString()).toBe('Ths is a tset.');

    const before = (await r.owner.req('GET', `/documents/${id}/versions`)).json().versions.length;
    const accepted = await r.editor.req('POST', `/ai/suggestions/${sid}/accept`);
    expect(accepted.statusCode).toBe(200);
    await until(() => watcher.text.toString() === 'This is a test.');
    expect(peer.text.toString()).toBe('This is a test.');

    // Attribution and a way back: a safety version exists, and the row records who accepted.
    const versions = (await r.owner.req('GET', `/documents/${id}/versions`)).json().versions as {
      label: string | null;
    }[];
    expect(versions.length).toBe(before + 1);
    expect(versions.some((v) => v.label === 'Before AI suggestion (grammar)')).toBe(true);
    expect((await status(r, r.owner, sid)).status).toBe('accepted');
    // Accepting twice is refused, not applied twice.
    expect((await r.editor.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(409);
    expect(peer.text.toString()).toBe('This is a test.');
  });

  it('works on a selection and leaves the rest of the document alone', async () => {
    const { id, peer } = await newDoc(r, 'Keep this. Fix thsi word. Keep that.');
    r.setReply((req) => documentOf(req).replace('thsi', 'this'));
    const from = peer.text.toString().indexOf('Fix');
    const to = peer.text.toString().indexOf(' Keep that');
    const res = await ask(r.owner, id, 'grammar', { peer, from, to });
    expect(res.statusCode).toBe(202);
    expect(res.json().suggestion.baseText).toBe('Fix thsi word.');
    const sid = res.json().suggestion.id;
    await settled(r, r.owner, sid);
    expect((await r.owner.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(200);
    await until(() => peer.text.toString() === 'Keep this. Fix this word. Keep that.');
  });

  it('shows "no changes" when the text is already fine, and can be rejected', async () => {
    const { id } = await newDoc(r, 'Nothing wrong here.');
    r.setReply((req) => documentOf(req));
    const sid = (await ask(r.owner, id, 'grammar')).json().suggestion.id;
    expect(await settled(r, r.owner, sid)).toMatchObject({
      status: 'failed',
      errorCode: 'no-changes',
    });

    r.setReply((req) => documentOf(req).replace('wrong', 'right'));
    const s2 = (await ask(r.owner, id, 'grammar')).json().suggestion.id;
    await settled(r, r.owner, s2);
    expect((await r.owner.req('POST', `/ai/suggestions/${s2}/reject`)).json()).toEqual({
      ok: true,
    });
    expect((await status(r, r.owner, s2)).status).toBe('rejected');
    expect((await r.owner.req('POST', `/ai/suggestions/${s2}/accept`)).statusCode).toBe(409);
  });

  it("refuses a rewrite that breaks the mode's contract instead of suggesting it", async () => {
    const { id } = await newDoc(r, 'A short sentence with a typo: teh cat.');
    r.setReply(
      () =>
        'Completely different prose about something unrelated, written at far greater length than before.',
    );
    const sid = (await ask(r.owner, id, 'grammar')).json().suggestion.id;
    const s = await settled(r, r.owner, sid);
    expect(s.status).toBe('failed');
    expect(['too-many-changes', 'length-changed']).toContain(s.errorCode);
  });
});

describe('permissions are enforced on the server', () => {
  let r: Rig;
  beforeAll(async () => (r = await rig()));
  afterAll(() => closeRig(r));

  it('viewers cannot invoke, accept, reject or cancel; outsiders cannot even see the document', async () => {
    const { id } = await newDoc(r, 'Ths is text.');
    r.setReply((req) => documentOf(req).replace('Ths', 'This'));
    const sid = (await ask(r.editor, id, 'grammar')).json().suggestion.id;
    await settled(r, r.editor, sid);

    expect((await ask(r.viewer, id, 'grammar')).statusCode).toBe(403);
    expect((await r.viewer.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(403);
    expect((await r.viewer.req('POST', `/ai/suggestions/${sid}/reject`)).statusCode).toBe(403);
    expect((await r.viewer.req('POST', `/ai/suggestions/${sid}/cancel`)).statusCode).toBe(403);
    // ...but a viewer may look at what is proposed.
    const list = (await r.viewer.req('GET', `/ai/suggestions?documentId=${id}`)).json();
    expect(list.canEdit).toBe(false);
    expect(list.suggestions.some((s: { id: string }) => s.id === sid)).toBe(true);
    expect((await status(r, r.editor, sid)).status).toBe('pending'); // untouched by the attempts

    expect((await ask(r.outsider, id, 'grammar')).statusCode).toBe(404);
    expect((await r.outsider.req('GET', `/ai/suggestions?documentId=${id}`)).statusCode).toBe(404);
    expect((await r.outsider.req('GET', `/ai/suggestions/${sid}`)).statusCode).toBe(404);
    expect((await r.outsider.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(404);
    const anon = await r.ctx.app.inject({
      method: 'POST',
      url: '/ai/suggestions',
      payload: { documentId: id, mode: 'grammar' },
    });
    expect(anon.statusCode).toBe(401);

    // a viewer's own (rejected) attempts never reached the model
    expect(r.llm.calls.length).toBe(1);
  });

  it('rejects malformed requests', async () => {
    const { id } = await newDoc(r, 'Some text.');
    expect(
      (await r.owner.rawReq('POST', '/ai/suggestions', { documentId: id, mode: 'nope' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await r.owner.rawReq('POST', '/ai/suggestions', { documentId: 'x', mode: 'grammar' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await r.owner.rawReq('POST', '/ai/suggestions', {
          documentId: id,
          mode: 'grammar',
          anchorStart: 'AAAA',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await r.owner.rawReq('POST', '/ai/suggestions', {
          documentId: id,
          mode: 'grammar',
          anchorStart: 'AAAA',
          anchorEnd: 'BBBB',
        })
      ).statusCode,
    ).toBe(400);
    const empty = await newDoc(r, '   ');
    expect((await ask(r.owner, empty.id, 'grammar')).statusCode).toBe(400);
  });
});

describe('stale suggestions', () => {
  let r: Rig;
  beforeAll(async () => (r = await rig()));
  afterAll(() => closeRig(r));

  const suggest = async (text: string, reply: (t: string) => string) => {
    const { id, peer } = await newDoc(r, text);
    r.setReply((req) => reply(documentOf(req)));
    const human = await join(r, r.editor, id);
    await until(() => human.text.toString() === text);
    const sid = (await ask(r.owner, id, 'grammar')).json().suggestion.id;
    await settled(r, r.owner, sid);
    return { id, peer, human, sid };
  };

  it('applies when people edited elsewhere in the meantime, keeping both sets of changes', async () => {
    const { human, peer, sid } = await suggest('alpha beta gamma', (t) =>
      t.replace('gamma', 'GAMMA'),
    );
    human.text.insert(0, 'NEW ');
    await until(() => peer.text.toString() === 'NEW alpha beta gamma');
    expect((await r.owner.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(200);
    await until(() => human.text.toString() === 'NEW alpha beta GAMMA');
  });

  it('is marked stale, and NOT applied, when a person edited the words the model changed', async () => {
    const { human, peer, sid, id } = await suggest('alpha beta gamma', (t) =>
      t.replace('beta', 'BETA'),
    );
    const at = human.text.toString().indexOf('beta');
    human.text.delete(at, 4);
    human.text.insert(at, 'bet');
    await until(() => peer.text.toString() === 'alpha bet gamma');

    // The list view notices without anyone clicking Accept.
    const listed = (await r.owner.req('GET', `/ai/suggestions?documentId=${id}`)).json()
      .suggestions as { id: string; status: string }[];
    expect(listed.find((s) => s.id === sid)?.status).toBe('stale');

    const res = await r.owner.req('POST', `/ai/suggestions/${sid}/accept`);
    expect(res.statusCode).toBe(409);
    expect(peer.text.toString()).toBe('alpha bet gamma'); // untouched
  });

  it('is stale if the selected text was deleted, and if so much changed that it cannot be trusted', async () => {
    const a = await suggest('alpha beta gamma delta', (t) => t.replace('delta', 'DELTA'));
    a.human.text.delete(0, a.human.text.length);
    a.human.text.insert(0, 'something completely unrelated now');
    await until(() => a.peer.text.toString() === 'something completely unrelated now');
    expect((await r.owner.req('POST', `/ai/suggestions/${a.sid}/accept`)).statusCode).toBe(409);
    expect(a.peer.text.toString()).toBe('something completely unrelated now');
  });

  it('text typed right at the edge of the selection is not swallowed into it', async () => {
    const { id, peer } = await newDoc(r, 'Keep. Fix thsi. Keep.');
    const human = await join(r, r.editor, id);
    await until(() => human.text.toString() === 'Keep. Fix thsi. Keep.');
    r.setReply((req) => documentOf(req).replace('thsi', 'this'));
    const from = peer.text.toString().indexOf('Fix');
    const to = from + 'Fix thsi.'.length;
    const sid = (await ask(r.owner, id, 'grammar', { peer, from, to })).json().suggestion.id;
    await settled(r, r.owner, sid);
    human.text.insert(to, ' EXTRA');
    human.text.insert(from, 'PRE ');
    await until(() => peer.text.toString() === 'Keep. PRE Fix thsi. EXTRA Keep.');
    expect((await r.owner.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(200);
    await until(() => peer.text.toString() === 'Keep. PRE Fix this. EXTRA Keep.');
  });
});

describe('two people and the agent editing at once converge', () => {
  let r: Rig;
  beforeAll(async () => (r = await rig()));
  afterAll(() => closeRig(r));

  it('every replica and the stored document agree, and no human edit is lost (8 randomised rounds)', async () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    let accepted = 0;
    let stale = 0;
    for (let round = 0; round < 8; round++) {
      const base = 'one two three four five six seven eight';
      const { id, peer: a } = await newDoc(r, base);
      const b = await join(r, r.editor, id);
      await until(() => b.text.toString() === base);
      r.setReply(async (req) => {
        await sleep(20 + rnd(40)); // the model is slow, people keep typing
        return documentOf(req).replace('five', 'FIVE').replace('two', 'TWO');
      });
      const sid = (await ask(r.owner, id, 'grammar')).json().suggestion.id;

      const inserted: string[] = [];
      for (let k = 0; k < 6; k++) {
        const who = rnd(2) ? a : b;
        const marker = ` m${round}${k}`;
        who.text.insert(rnd(who.text.length + 1), marker);
        inserted.push(marker.trim());
        await sleep(rnd(15));
      }
      await settled(r, r.owner, sid);
      const res = await r.owner.req('POST', `/ai/suggestions/${sid}/accept`);
      expect([200, 409]).toContain(res.statusCode);
      if (res.statusCode === 200) accepted++;
      else stale++;

      await until(() => a.text.toString() === b.text.toString(), 5000, 'replicas to converge');
      const final = a.text.toString();
      for (const m of inserted) expect(final, `human edit ${m} survived`).toContain(m);
      if (res.statusCode === 200) {
        expect(final).toContain('FIVE');
        expect(final).toContain('TWO');
      } else {
        expect(final).not.toContain('FIVE'); // stale means nothing of the suggestion was applied
      }
      // The stored document equals what the clients converged on.
      await a.close();
      await b.close();
      await sleep(150);
      const fresh = await join(r, r.owner, id);
      await until(() => fresh.synced);
      expect(fresh.text.toString()).toBe(final);
    }
    expect(accepted + stale).toBe(8);
  });
});

describe('usage safeguards', () => {
  it('rate-limits each user and says when to retry', async () => {
    const r = await rig({ AI_RATE_PER_MINUTE: '2' });
    try {
      const { id } = await newDoc(r, 'Ths is text.');
      r.setReply((req) => documentOf(req).replace('Ths', 'This'));
      for (let i = 0; i < 2; i++) {
        const res = await ask(r.owner, id, 'grammar');
        expect(res.statusCode).toBe(202);
        await settled(r, r.owner, res.json().suggestion.id);
      }
      const third = await ask(r.owner, id, 'grammar');
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toBe('rate-limited');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      // another user is unaffected
      expect((await ask(r.editor, id, 'grammar')).statusCode).toBe(202);
      const st = (await r.owner.req('GET', '/ai/status')).json();
      expect(st.limits.remaining.minute).toBe(0);
    } finally {
      await closeRig(r);
    }
  });

  it('allows one running request per user', async () => {
    const r = await rig();
    try {
      const { id } = await newDoc(r, 'Ths is text.');
      const hold = deferred<void>();
      r.setReply(async (req) => {
        await hold.promise;
        return documentOf(req).replace('Ths', 'This');
      });
      const first = await ask(r.owner, id, 'grammar');
      expect(first.statusCode).toBe(202);
      expect((await ask(r.owner, id, 'grammar')).json().error).toBe('busy');
      hold.resolve();
      await settled(r, r.owner, first.json().suggestion.id);
      expect((await ask(r.owner, id, 'grammar')).statusCode).toBe(202);
    } finally {
      await closeRig(r);
    }
  });

  it('switches the AI off cleanly when the daily budget is spent, tells the UI, and spares own-key requests', async () => {
    const r = await rig({ AI_DAILY_TOKEN_BUDGET: '150' });
    try {
      const { id } = await newDoc(r, 'Ths is text.');
      r.setReply((req) => ({ text: documentOf(req).replace('Ths', 'This'), tokens: 100 }));
      const events: { type: string; exhausted?: boolean }[] = [];
      const { default: WebSocket } = await import('ws');
      const ws = new WebSocket(`${r.base}/ws/ai?doc=${id}`, {
        headers: { cookie: r.owner.cookie },
      });
      ws.on('message', (d) => events.push(JSON.parse(d.toString())));
      await until(() => events.some((e) => e.type === 'ready'));

      const one = (await ask(r.owner, id, 'grammar')).json().suggestion.id;
      expect((await settled(r, r.owner, one)).status).toBe('pending'); // 100 of 150 spent
      expect((await r.owner.req('GET', '/ai/status')).json().budget).toMatchObject({
        exhausted: false,
        usedToday: 100,
      });

      const two = (await ask(r.owner, id, 'grammar')).json().suggestion.id; // crosses the budget
      expect(await settled(r, r.owner, two)).toMatchObject({
        status: 'failed',
        errorCode: 'global-budget',
      });

      const blocked = await ask(r.owner, id, 'grammar');
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json()).toMatchObject({ error: 'budget-exhausted' });
      expect(blocked.json().resetsAt).toMatch(/T00:00:00/);
      const st = (await r.owner.req('GET', '/ai/status')).json();
      expect(st.budget).toMatchObject({ enabled: true, exhausted: true });
      await until(() => events.some((e) => e.type === 'budget' && e.exhausted));
      ws.close();

      // A user's own key spends their own quota, so the shared budget does not stop it.
      const callsBefore = r.llm.calls.length;
      const own = await ask(r.owner, id, 'grammar', undefined, OWN_KEY);
      expect(own.statusCode).toBe(202);
      await settled(r, r.owner, own.json().suggestion.id);
      expect(r.llm.calls[callsBefore]!.apiKey).toBe(OWN_KEY);
      expect((await r.owner.req('GET', '/ai/status')).json().budget.usedToday).toBe(200); // unchanged by the own-key run
    } finally {
      await closeRig(r);
    }
  });

  it('is invite-only when an allow-list is set', async () => {
    const r = await rig({ AI_ALLOWED_EMAILS: 'Editor@example.com, someone@else.org' });
    try {
      const { id } = await newDoc(r, 'Ths is text.');
      r.setReply((req) => documentOf(req).replace('Ths', 'This'));
      expect((await ask(r.owner, id, 'grammar')).statusCode).toBe(403);
      expect((await ask(r.owner, id, 'grammar')).json().error).toContain('invite-only');
      expect((await ask(r.editor, id, 'grammar')).statusCode).toBe(202); // case-insensitive match
      const st = (await r.owner.req('GET', '/ai/status')).json();
      expect(st.invite).toEqual({ restricted: true, allowed: false });
      expect(
        (await r.owner.rawReq('POST', '/ai/key/check', {}, { 'x-ai-key': OWN_KEY })).statusCode,
      ).toBe(403);
    } finally {
      await closeRig(r);
    }
  });

  it('reports a missing model, and validates input sizes', async () => {
    const r = await rig({ AI_MAX_INPUT_CHARS: '200' });
    try {
      const { id } = await newDoc(r, 'x'.repeat(300));
      expect((await ask(r.owner, id, 'grammar')).statusCode).toBe(413);
      r.llm.serverKeyConfigured = false;
      const small = await newDoc(r, 'Short text.');
      const res = await ask(r.owner, small.id, 'grammar');
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('not-configured');
      expect((await ask(r.owner, small.id, 'expand')).statusCode).toBe(503); // search comes from the fake: configured
      // with the user's own key it runs
      expect((await ask(r.owner, small.id, 'grammar', undefined, OWN_KEY)).statusCode).toBe(202);
    } finally {
      await closeRig(r);
    }
  });
});

describe("the user's own key never leaks", () => {
  it('does not appear in any log line, response body or header, or in the database', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const r = await rig({}, { logStream });
    try {
      const { id } = await newDoc(r, 'Ths is text.');
      const everything: string[] = [];
      const track = async (p: ReturnType<Client['req']>) => {
        const res = await p;
        everything.push(res.body, JSON.stringify(res.headers));
        return res;
      };

      // key check, success and failure paths of a run, malformed key, usage refresh
      r.llm.probeHeaders = { 'x-ratelimit-remaining-requests': '99' };
      const check = await track(
        r.owner.rawReq('POST', '/ai/key/check', {}, { 'x-ai-key': OWN_KEY }),
      );
      expect(check.json()).toMatchObject({ accepted: true });
      expect(r.llm.probes).toContain(OWN_KEY); // it was used for the probe...
      await track(r.owner.rawReq('POST', '/ai/usage/refresh', {}, { 'x-ai-key': OWN_KEY }));
      await track(
        r.owner.rawReq('POST', '/ai/key/check', {}, { 'x-ai-key': `${OWN_KEY} with spaces` }),
      );

      r.setReply((req) => documentOf(req).replace('Ths', 'This'));
      const ok = await track(ask(r.owner, id, 'grammar', undefined, OWN_KEY));
      const okId = ok.json().suggestion.id;
      await settled(r, r.owner, okId);
      await track(r.owner.req('GET', `/ai/suggestions/${okId}`));
      await track(r.owner.req('GET', `/ai/suggestions?documentId=${id}`));
      await track(r.owner.req('GET', '/ai/status'));

      for (const err of [
        new LlmError('auth', 401, {}, `bad key ${OWN_KEY}`),
        new LlmError('rate-limit', 429, { 'retry-after': '3' }, `tokens per minute ${OWN_KEY}`),
        new Error(`boom ${OWN_KEY} ${SERVER_KEY}`),
      ]) {
        r.setReply(() => {
          throw err;
        });
        const bad = await track(ask(r.owner, id, 'grammar', undefined, OWN_KEY));
        await settled(r, r.owner, bad.json().suggestion.id);
      }
      await track(r.owner.req('GET', `/ai/suggestions?documentId=${id}`));
      await sleep(100);

      const rows = await r.ctx.db.query('SELECT * FROM ai_suggestions');
      const usage = await r.ctx.db.query('SELECT * FROM ai_usage_daily');
      const sessions = await r.ctx.db.query('SELECT * FROM sessions');
      everything.push(JSON.stringify(rows.rows), JSON.stringify(usage.rows));

      const logs = lines.join('');
      expect(logs.length).toBeGreaterThan(200); // the log really captured the requests
      for (const secret of [OWN_KEY, SERVER_KEY, 'tvly-x']) {
        expect(logs, `log contains ${secret.slice(0, 8)}`).not.toContain(secret);
        expect(everything.join('\n'), `response/db contains ${secret.slice(0, 8)}`).not.toContain(
          secret,
        );
      }
      // failures are logged as codes only
      expect(logs).toContain('ai run ended without a suggestion');
      expect(sessions.rows.length).toBeGreaterThan(0);
      // the key never reached the model for runs that did not carry it
      r.setReply((req) => documentOf(req));
      await settled(r, r.owner, (await ask(r.owner, id, 'grammar')).json().suggestion.id);
      expect(r.llm.calls.at(-1)!.apiKey).toBeUndefined();
    } finally {
      await closeRig(r);
    }
  });
});

describe('adding a mode is one config entry', () => {
  it('a new rewrite mode gets suggestions, anchoring and accept/reject with no other code', async () => {
    const shout: ModeConfig = {
      id: 'shout',
      label: 'Shout',
      description: 'Uppercase everything.',
      kind: 'rewrite',
      placement: 'replace',
      temperature: 0,
      system: 'Uppercase the text.',
    };
    const r = await rig({}, { modes: [...MODES, shout] });
    try {
      const { id, peer } = await newDoc(r, 'make me loud');
      r.setReply((req) => documentOf(req).toUpperCase());
      const modes = (await r.owner.req('GET', '/ai/status')).json().modes as { id: string }[];
      expect(modes.map((m) => m.id)).toContain('shout');
      const sid = (await ask(r.owner, id, 'shout')).json().suggestion.id;
      await settled(r, r.owner, sid);
      expect((await r.owner.req('POST', `/ai/suggestions/${sid}/accept`)).statusCode).toBe(200);
      await until(() => peer.text.toString() === 'MAKE ME LOUD');
    } finally {
      await closeRig(r);
    }
  });
});

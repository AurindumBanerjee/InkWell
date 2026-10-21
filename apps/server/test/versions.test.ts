import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { replaceText } from '../src/versions.js';
import { Client, setupApp, type TestCtx } from './helpers.js';
import { Peer, waitFor } from './ws-peer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('replaceText', () => {
  it('always turns any text into any other text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        const doc = new Y.Doc();
        const t = doc.getText('content');
        t.insert(0, a);
        replaceText(t, b);
        return t.toString() === b;
      }),
      { numRuns: 500 },
    );
  });

  it('is a minimal edit: untouched head and tail keep their CRDT identity', () => {
    // A concurrent replica inserting inside the unchanged prefix must survive the restore.
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('content').insert(0, 'Hello world, this is the old ending');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText('content').insert(5, ' there'); // concurrent edit in the shared prefix
    replaceText(a.getText('content'), 'Hello world, this is the new ending');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getText('content').toString()).toBe('Hello there world, this is the new ending');
    expect(b.getText('content').toString()).toBe(a.getText('content').toString());
  });
});

describe('version history API', () => {
  let ctx: TestCtx;
  let base: string;
  let owner: Client, editor: Client, viewer: Client, outsider: Client;
  let wsId: string;
  const peers: Peer[] = [];

  const newDoc = async (): Promise<string> => {
    const id: string = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json()
      .document.id;
    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'editor@example.com',
      role: 'editor',
    });
    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'viewer@example.com',
      role: 'viewer',
    });
    return id;
  };
  const join = async (c: Client, id: string): Promise<Peer> => {
    const p = await Peer.connect(`${base}/ws/docs/${id}`, { cookie: c.cookie });
    peers.push(p);
    return p;
  };
  const leaveAll = async () => {
    await Promise.all(peers.splice(0).map((p) => p.close()));
    await sleep(200); // rooms flush, compact and auto-version on teardown
  };
  const versions = async (id: string) =>
    (await owner.req('GET', `/documents/${id}/versions`)).json().versions as {
      id: string;
      kind: string;
      label: string | null;
      preview: string;
    }[];

  beforeAll(async () => {
    ctx = await setupApp({
      sync: { flushMs: 10, versionGapMs: 0, maxAutoVersions: 3, reauthMs: 60_000 },
    });
    base = await ctx.listen();
    owner = await new Client(ctx.app).login('owner@example.com');
    editor = await new Client(ctx.app).login('editor@example.com');
    viewer = await new Client(ctx.app).login('viewer@example.com');
    outsider = await new Client(ctx.app).login('outsider@example.com');
    wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
  });
  afterEach(leaveAll);
  afterAll(() => ctx.close());

  it('saves a named version of the live text and serves it back', async () => {
    const id = await newDoc();
    const p = await join(owner, id);
    p.text.insert(0, 'first draft');
    await waitFor(() => p.text.toString() === 'first draft');
    await sleep(50);

    const res = await owner.req('POST', `/documents/${id}/versions`, { label: 'v1' });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toMatchObject({ kind: 'manual', label: 'v1', text: 'first draft' });

    const listed = await versions(id);
    expect(listed.find((v) => v.label === 'v1')).toBeTruthy();
    const got = await owner.req('GET', `/documents/${id}/versions/${res.json().version.id}`);
    expect(got.json().version.text).toBe('first draft');
  });

  it('restores an old version into the live document, keeping a way back', async () => {
    const id = await newDoc();
    const live = await join(owner, id);
    const watcher = await join(editor, id);
    live.text.insert(0, 'Version one text.');
    await waitFor(() => watcher.text.toString() === 'Version one text.');
    await sleep(50);
    const v1 = (await owner.req('POST', `/documents/${id}/versions`, { label: 'one' })).json()
      .version;

    live.text.insert(live.text.length, ' Plus later edits.');
    await waitFor(() => watcher.text.toString() === 'Version one text. Plus later edits.');

    const res = await editor.req('POST', `/documents/${id}/versions/${v1.id}/restore`);
    expect(res.statusCode).toBe(200);
    // Connected clients converge on the restored text without reconnecting.
    await waitFor(() => live.text.toString() === 'Version one text.', 5000, 'owner sees restore');
    await waitFor(
      () => watcher.text.toString() === 'Version one text.',
      5000,
      'editor sees restore',
    );

    // The text that was replaced is kept, so the restore itself can be undone.
    const safety = (await versions(id)).find((v) => v.kind === 'restore');
    expect(safety?.label).toBe('Before restore');
    const old = await owner.req('GET', `/documents/${id}/versions/${safety!.id}`);
    expect(old.json().version.text).toBe('Version one text. Plus later edits.');

    // And it persisted: a brand-new client, after everyone left, sees the restored text.
    await leaveAll();
    const fresh = await join(owner, id);
    expect(fresh.text.toString()).toBe('Version one text.');
  });

  it('enforces roles and ownership of versions', async () => {
    const id = await newDoc();
    const p = await join(owner, id);
    p.text.insert(0, 'secret');
    await sleep(100);
    const v = (await owner.req('POST', `/documents/${id}/versions`, {})).json().version;

    // viewers can read history but not create or restore
    expect((await viewer.req('GET', `/documents/${id}/versions`)).statusCode).toBe(200);
    expect((await viewer.req('GET', `/documents/${id}/versions/${v.id}`)).statusCode).toBe(200);
    expect((await viewer.req('POST', `/documents/${id}/versions`, {})).statusCode).toBe(403);
    expect((await viewer.req('POST', `/documents/${id}/versions/${v.id}/restore`)).statusCode).toBe(
      403,
    );
    // outsiders cannot even tell the document exists
    expect((await outsider.req('GET', `/documents/${id}/versions`)).statusCode).toBe(404);
    expect((await outsider.req('GET', `/documents/${id}/versions/${v.id}`)).statusCode).toBe(404);
    // a version id from another document does not resolve
    const other = await newDoc();
    expect((await owner.req('GET', `/documents/${other}/versions/${v.id}`)).statusCode).toBe(404);
    expect((await owner.req('GET', `/documents/${id}/versions/not-a-uuid`)).statusCode).toBe(400);
  });

  it('takes an automatic version when the last editor leaves a changed document', async () => {
    const id = await newDoc();
    const p = await join(owner, id);
    p.text.insert(0, 'auto one');
    await sleep(100);
    await leaveAll();
    expect((await versions(id)).filter((v) => v.kind === 'auto')).toHaveLength(1);

    // reopening and leaving without edits adds nothing
    await join(owner, id);
    await leaveAll();
    expect((await versions(id)).filter((v) => v.kind === 'auto')).toHaveLength(1);

    // a real edit adds another
    const again = await join(owner, id);
    again.text.insert(again.text.length, ' and two');
    await sleep(100);
    await leaveAll();
    const autos = (await versions(id)).filter((v) => v.kind === 'auto');
    expect(autos).toHaveLength(2);
    expect(autos[0]!.preview).toBe('auto one and two'); // newest first
  });

  it('prunes automatic versions but never manual ones', async () => {
    const id = await newDoc();
    const first = await join(owner, id);
    first.text.insert(0, 'm');
    await sleep(100);
    await owner.req('POST', `/documents/${id}/versions`, { label: 'keep me' });
    await leaveAll();
    for (let i = 0; i < 6; i++) {
      const p = await join(owner, id);
      p.text.insert(p.text.length, String(i));
      await sleep(80);
      await leaveAll();
    }
    const all = await versions(id);
    expect(all.filter((v) => v.kind === 'auto').length).toBeLessThanOrEqual(3);
    expect(all.some((v) => v.label === 'keep me')).toBe(true);
  });
});

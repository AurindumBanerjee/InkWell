import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, setupApp, type TestCtx } from './helpers.js';
import { Peer, waitFor } from './ws-peer.js';

/** A valid base64 Yjs relative position, as the browser produces for a text selection. */
function anchorAt(index: number): string {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, 'hello world, this is a document');
  return Buffer.from(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index)),
  ).toString('base64');
}

describe('comments API', () => {
  let ctx: TestCtx;
  let base: string;
  let owner: Client, editor: Client, viewer: Client, outsider: Client;
  let wsId: string;
  let docId: string;
  const peers: Peer[] = [];

  const comment = async (c: Client, body: object, id = docId) =>
    c.req('POST', `/documents/${id}/comments`, body);
  const list = async (c: Client = owner, id = docId) =>
    (await c.req('GET', `/documents/${id}/comments`)).json().comments as {
      id: string;
      body: string;
      parent_id: string | null;
      author_name: string;
      resolved_at: string | null;
      quoted_text: string | null;
    }[];

  beforeAll(async () => {
    ctx = await setupApp({ sync: { reauthMs: 60_000 } });
    base = await ctx.listen();
    owner = await new Client(ctx.app).login('owner@example.com', 'Olive');
    editor = await new Client(ctx.app).login('editor@example.com', 'Eddie');
    viewer = await new Client(ctx.app).login('viewer@example.com', 'Vera');
    outsider = await new Client(ctx.app).login('outsider@example.com');
    wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
    docId = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    await owner.req('PUT', `/documents/${docId}/shares`, {
      email: 'editor@example.com',
      role: 'editor',
    });
    await owner.req('PUT', `/documents/${docId}/shares`, {
      email: 'viewer@example.com',
      role: 'viewer',
    });
  });
  afterEach(async () => {
    await Promise.all(peers.splice(0).map((p) => p.close()));
  });
  afterAll(() => ctx.close());

  it('creates an anchored comment and lists it with its author', async () => {
    const res = await comment(owner, {
      body: 'Is this right?',
      anchorStart: anchorAt(0),
      anchorEnd: anchorAt(5),
      quoted: 'hello',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().comment).toMatchObject({
      body: 'Is this right?',
      author_name: 'Olive',
      quoted_text: 'hello',
    });
    expect((await list()).some((c) => c.body === 'Is this right?')).toBe(true);
  });

  it('lets read-only viewers comment, but hides the document from outsiders', async () => {
    expect((await comment(viewer, { body: 'Looks good to me' })).statusCode).toBe(201);
    expect((await comment(outsider, { body: 'hi' })).statusCode).toBe(404);
    expect((await outsider.req('GET', `/documents/${docId}/comments`)).statusCode).toBe(404);
  });

  it('validates input', async () => {
    expect((await comment(owner, { body: '' })).statusCode).toBe(400);
    expect((await comment(owner, { body: 'x'.repeat(4001) })).statusCode).toBe(400);
    // anchors must come as a pair and decode to real relative positions
    expect((await comment(owner, { body: 'a', anchorStart: anchorAt(1) })).statusCode).toBe(400);
    expect(
      (await comment(owner, { body: 'a', anchorStart: 'AAAA', anchorEnd: 'not base64 !!' }))
        .statusCode,
    ).toBe(400);
  });

  it('threads replies one level deep, within the same document', async () => {
    const root = (await comment(owner, { body: 'thread root' })).json().comment;
    const reply = await comment(editor, { body: 'a reply', parentId: root.id });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().comment.parent_id).toBe(root.id);
    // no nesting, no anchors on replies, no cross-document parents
    expect(
      (await comment(owner, { body: 'deep', parentId: reply.json().comment.id })).statusCode,
    ).toBe(400);
    expect(
      (
        await comment(owner, {
          body: 'x',
          parentId: root.id,
          anchorStart: anchorAt(1),
          anchorEnd: anchorAt(2),
        })
      ).statusCode,
    ).toBe(400);
    const other = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    expect((await comment(owner, { body: 'x', parentId: root.id }, other)).statusCode).toBe(404);
  });

  it('resolves threads: editors or the thread author, not other viewers', async () => {
    const byViewer = (await comment(viewer, { body: 'viewer question' })).json().comment;
    const other = (await comment(owner, { body: 'owner thread' })).json().comment;
    const resolve = (c: Client, id: string, resolved: boolean) =>
      c.req('PATCH', `/documents/${docId}/comments/${id}`, { resolved });

    expect((await resolve(viewer, other.id, true)).statusCode).toBe(403); // not their thread
    expect((await resolve(viewer, byViewer.id, true)).statusCode).toBe(200); // their own thread
    expect((await resolve(editor, byViewer.id, false)).statusCode).toBe(200); // editors can reopen
    expect((await resolve(editor, other.id, true)).json().comment.resolved_at).not.toBeNull();
  });

  it('only the author edits a comment; the author or an owner deletes it', async () => {
    const mine = (await comment(editor, { body: 'original' })).json().comment;
    const patch = (c: Client, body: string) =>
      c.req('PATCH', `/documents/${docId}/comments/${mine.id}`, { body });
    expect((await patch(owner, 'hijack')).statusCode).toBe(403);
    const edited = await patch(editor, 'edited');
    expect(edited.json().comment).toMatchObject({ body: 'edited' });
    expect(edited.json().comment.edited_at).not.toBeNull();

    expect((await viewer.req('DELETE', `/documents/${docId}/comments/${mine.id}`)).statusCode).toBe(
      403,
    );
    expect((await owner.req('DELETE', `/documents/${docId}/comments/${mine.id}`)).statusCode).toBe(
      200,
    );
    expect((await list()).some((c) => c.id === mine.id)).toBe(false);
  });

  it('deleting a thread removes its replies', async () => {
    const root = (await comment(owner, { body: 'to delete' })).json().comment;
    await comment(editor, { body: 'reply 1', parentId: root.id });
    await owner.req('DELETE', `/documents/${docId}/comments/${root.id}`);
    expect((await list()).filter((c) => c.parent_id === root.id)).toHaveLength(0);
  });

  it('pings connected clients when comments change', async () => {
    const watcher = await Peer.connect(`${base}/ws/docs/${docId}`, { cookie: viewer.cookie });
    peers.push(watcher);
    const before = watcher.commentPings;
    const created = (await comment(owner, { body: 'live!' })).json().comment;
    await waitFor(() => watcher.commentPings === before + 1, 5000, 'ping on create');
    await editor.req('PATCH', `/documents/${docId}/comments/${created.id}`, { resolved: true });
    await waitFor(() => watcher.commentPings === before + 2, 5000, 'ping on resolve');
    await owner.req('DELETE', `/documents/${docId}/comments/${created.id}`);
    await waitFor(() => watcher.commentPings === before + 3, 5000, 'ping on delete');
  });

  it('does not ping clients of other documents', async () => {
    const otherDoc = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document
      .id;
    const bystander = await Peer.connect(`${base}/ws/docs/${otherDoc}`, { cookie: owner.cookie });
    peers.push(bystander);
    await comment(owner, { body: 'elsewhere' });
    await new Promise((r) => setTimeout(r, 200));
    expect(bystander.commentPings).toBe(0);
  });
});

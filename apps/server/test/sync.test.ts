import * as awarenessProtocol from 'y-protocols/awareness';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupApp, type TestCtx } from './helpers.js';
import { Peer, waitFor } from './ws-peer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ctx: TestCtx;
let base: string;
let owner: Client, editor: Client, viewer: Client, outsider: Client;
let wsId: string;
let docId: string;
const peers: Peer[] = [];

const connect = async (c: Client | null, id = docId, origin?: string) => {
  const p = await Peer.connect(`${base}/ws/docs/${id}`, { cookie: c?.cookie, origin });
  peers.push(p);
  return p;
};

beforeAll(async () => {
  ctx = await setupApp({
    sync: { flushMs: 10, compactEvery: 3, reauthMs: 50, compactIntervalMs: 60_000 },
  });
  base = await ctx.listen();
  owner = await new Client(ctx.app).login('owner@example.com');
  editor = await new Client(ctx.app).login('editor@example.com');
  viewer = await new Client(ctx.app).login('viewer@example.com');
  outsider = await new Client(ctx.app).login('outsider@example.com');
  wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
  docId = (await owner.req('POST', `/workspaces/${wsId}/documents`, { title: 'Sync' })).json()
    .document.id;
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

const persistedText = async (id = docId): Promise<string> => {
  const fresh = await connect(owner, id);
  const text = fresh.text.toString();
  await fresh.close();
  return text;
};

describe('connection gating', () => {
  it('rejects unauthenticated sockets', async () => {
    const p = await connect(null);
    await waitFor(() => p.closeCode !== null);
    expect(p.closeCode).toBe(4401);
  });

  it('rejects cross-site origins', async () => {
    const p = await connect(owner, docId, 'https://evil.example');
    await waitFor(() => p.closeCode !== null);
    expect(p.closeCode).toBe(4403);
  });

  it('hides documents the user cannot access', async () => {
    const p = await connect(outsider);
    await waitFor(() => p.closeCode !== null);
    expect(p.closeCode).toBe(4404);
    const bad = await connect(owner, 'not-a-uuid');
    await waitFor(() => bad.closeCode !== null);
    expect(bad.closeCode).toBe(4404);
  });

  it('closes on malformed messages', async () => {
    const p = await connect(owner);
    p.send(new Uint8Array([99, 1, 2]));
    await waitFor(() => p.closeCode !== null);
    expect(p.closeCode).toBe(4400);
  });
});

describe('realtime sync', () => {
  it('propagates edits between editors and converges under concurrent typing', async () => {
    const a = await connect(owner);
    const b = await connect(editor);
    a.text.insert(0, 'hello');
    await waitFor(() => b.text.toString() === 'hello', 5000, 'b sees hello');

    // Concurrent edits at the same position from both sides.
    a.text.insert(5, ' from A');
    b.text.insert(5, ' from B');
    await waitFor(
      () =>
        a.text.toString() === b.text.toString() && a.text.length === 'hello from A from B'.length,
      5000,
      'convergence',
    );
    expect(a.text.toString()).toBe(b.text.toString());
    expect(a.text.toString()).toContain('from A');
    expect(a.text.toString()).toContain('from B');
  });

  it('lets viewers read but silently drops their writes', async () => {
    const a = await connect(owner);
    a.text.delete(0, a.text.length);
    a.text.insert(0, 'readonly-test');
    const v = await connect(viewer);
    await waitFor(() => v.text.toString() === 'readonly-test', 5000, 'viewer reads');

    v.text.insert(0, 'HACK ');
    await sleep(200);
    expect(a.text.toString()).toBe('readonly-test');
    expect(await persistedText()).toBe('readonly-test');
    expect(v.closeCode).toBeNull(); // dropped, not disconnected
  });

  it('keeps viewers receiving live updates', async () => {
    const a = await connect(owner);
    const v = await connect(viewer);
    a.text.insert(a.text.length, '!');
    await waitFor(() => v.text.toString().endsWith('!'), 5000, 'viewer sees live edit');
  });
});

describe('persistence', () => {
  it('survives all clients leaving (snapshot + log replay) and compacts the log', async () => {
    const id = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    const a = await connect(owner, id);
    for (const word of ['one ', 'two ', 'three ', 'four ']) {
      a.text.insert(a.text.length, word);
      await sleep(30); // separate flush batches
    }
    await a.close();
    await sleep(200);

    const { rows: snaps } = await ctx.db.query(
      'SELECT last_update_id FROM document_snapshots WHERE document_id = $1',
      [id],
    );
    expect(snaps).toHaveLength(1);
    const { rows: left } = await ctx.db.query(
      'SELECT count(*)::int AS n FROM document_updates WHERE document_id = $1',
      [id],
    );
    expect(left[0].n).toBe(0); // everything folded into the snapshot
    expect(await persistedText(id)).toBe('one two three four ');
  });

  it('compacts periodically while the room stays open', async () => {
    const id = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    const a = await connect(owner, id);
    for (let i = 0; i < 5; i++) {
      a.text.insert(a.text.length, `${i}`);
      await sleep(30);
    }
    await sleep(200);
    const { rows } = await ctx.db.query('SELECT 1 FROM document_snapshots WHERE document_id = $1', [
      id,
    ]);
    expect(rows).toHaveLength(1); // threshold (3) crossed without anyone disconnecting
    expect(a.text.toString()).toBe('01234');
  });

  it('a late joiner converges with state written across snapshot and log', async () => {
    const id = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'editor@example.com',
      role: 'editor',
    });
    const a = await connect(owner, id);
    for (let i = 0; i < 4; i++) {
      a.text.insert(a.text.length, `${i}`);
      await sleep(30);
    }
    const late = await connect(editor, id);
    await waitFor(() => late.text.toString() === '0123', 5000, 'late joiner state');
  });
});

describe('access changes while connected', () => {
  it('disconnects a viewer whose share is revoked', async () => {
    const id = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'viewer@example.com',
      role: 'viewer',
    });
    const v = await connect(viewer, id);
    const shareId = (await owner.req('GET', `/documents/${id}/shares`)).json().shares[0].id;
    await owner.req('DELETE', `/documents/${id}/shares/${shareId}`);
    await waitFor(() => v.closeCode !== null, 5000, 'revocation close');
    expect(v.closeCode).toBe(4403);
  });

  it('downgrading an editor to viewer stops their writes taking effect', async () => {
    const id = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json().document.id;
    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'editor@example.com',
      role: 'editor',
    });
    const e = await connect(editor, id);
    const o = await connect(owner, id);
    e.text.insert(0, 'ok');
    await waitFor(() => o.text.toString() === 'ok', 5000, 'editor write lands');

    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'editor@example.com',
      role: 'viewer',
    });
    await sleep(200); // > reauthMs
    e.text.insert(2, ' nope');
    await sleep(200);
    expect(o.text.toString()).toBe('ok');
  });
});

describe('presence', () => {
  it('shares awareness state and clears it when a peer disconnects', async () => {
    const a = await connect(owner);
    const b = await connect(editor);
    a.awareness.setLocalState({ user: { name: 'Owner', color: '#f00' }, cursor: 3 });
    await waitFor(
      () => b.awareness.getStates().get(a.doc.clientID) !== undefined,
      5000,
      'presence',
    );
    expect(b.awareness.getStates().get(a.doc.clientID)).toMatchObject({ user: { name: 'Owner' } });

    await a.close();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), 5000, 'presence cleared');
  });

  it('delivers existing presence to late joiners, including viewers', async () => {
    const a = await connect(owner);
    a.awareness.setLocalState({ user: { name: 'Early' } });
    await sleep(100);
    const v = await connect(viewer);
    await waitFor(() => v.awareness.getStates().has(a.doc.clientID), 5000, 'late presence');
    awarenessProtocol.removeAwarenessStates(v.awareness, [v.doc.clientID], 'test');
  });
});

import * as decoding from 'lib0/decoding';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryBus, RedisBus, type Bus } from '../src/sync/bus.js';
import { channelFor } from '../src/sync/room.js';
import { Client, setupApp, type TestCtx } from './helpers.js';
import { Peer, waitFor } from './ws-peer.js';

/**
 * Two (or three) sync nodes sharing one Postgres and one bus. Every scenario runs against the
 * in-process bus; the same scenarios also run against real Redis when REDIS_URL is set (CI sets it,
 * locally: `docker run -p 6379:6379 redis:7-alpine`).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REDIS_URL = process.env.REDIS_URL;

interface Flavor {
  name: string;
  /** One bus per node (in-process: all nodes share one instance). */
  makeBus: () => (() => Bus) & { memory?: InMemoryBus };
  skip: boolean;
}

const flavors: Flavor[] = [
  {
    name: 'in-memory bus',
    skip: false,
    makeBus: () => {
      const bus = new InMemoryBus();
      const f = (() => bus) as (() => Bus) & { memory?: InMemoryBus };
      f.memory = bus;
      return f;
    },
  },
  {
    name: 'redis bus',
    skip: !REDIS_URL,
    makeBus: () => (() => new RedisBus(REDIS_URL!)) as () => Bus,
  },
];

describe.each(flavors)('cluster over $name', ({ makeBus, skip }) => {
  let busFor: ReturnType<Flavor['makeBus']>;
  let a: TestCtx, b: TestCtx;
  let urlA: string, urlB: string;
  let owner: Client, editor: Client, viewer: Client;
  let wsId: string;
  const peers: Peer[] = [];
  const extra: TestCtx[] = [];
  const nodeSync = { flushMs: 3000, compactEvery: 1000, reauthMs: 60_000 };

  const newDoc = async (): Promise<string> => {
    const id: string = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json()
      .document.id;
    for (const [email, role] of [
      ['editor@example.com', 'editor'],
      ['viewer@example.com', 'viewer'],
    ] as const) {
      await owner.req('PUT', `/documents/${id}/shares`, { email, role });
    }
    return id;
  };
  const join = async (base: string, c: Client, id: string): Promise<Peer> => {
    const p = await Peer.connect(`${base}/ws/docs/${id}`, { cookie: c.cookie });
    peers.push(p);
    return p;
  };
  const closePeers = async () => {
    await Promise.all(peers.splice(0).map((p) => p.close()));
  };

  beforeAll(async () => {
    if (skip) return;
    busFor = makeBus();
    a = await setupApp({ bus: busFor(), serverId: 'node-a', sync: nodeSync });
    b = await setupApp({ sharedWith: a, bus: busFor(), serverId: 'node-b', sync: nodeSync });
    urlA = await a.listen();
    urlB = await b.listen();
    owner = await new Client(a.app).login('owner@example.com');
    editor = await new Client(a.app).login('editor@example.com');
    viewer = await new Client(a.app).login('viewer@example.com');
    wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
  });

  afterAll(async () => {
    if (skip) return;
    await closePeers();
    for (const c of extra) await c.close();
    await b.close();
    await a.close();
  });

  const t = skip ? it.skip : it;

  t(
    'edits made on one node reach clients on the other, and concurrent edits converge',
    async () => {
      const id = await newDoc();
      const pa = await join(urlA, owner, id);
      const pb = await join(urlB, editor, id);
      pa.text.insert(0, 'from A');
      await waitFor(() => pb.text.toString() === 'from A', 5000, 'A -> B');
      pb.text.insert(pb.text.length, ' and B');
      await waitFor(() => pa.text.toString() === 'from A and B', 5000, 'B -> A');

      pa.text.insert(0, '[a]');
      pb.text.insert(0, '[b]');
      await waitFor(
        () =>
          pa.text.toString() === pb.text.toString() && pa.text.length === 'from A and B'.length + 6,
        5000,
        'concurrent convergence across nodes',
      );
      await closePeers();
    },
  );

  t('presence crosses nodes and is cleared when the client leaves', async () => {
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    const pb = await join(urlB, editor, id);
    pa.awareness.setLocalState({ user: { id: 'u1', name: 'Alice' } });
    await waitFor(() => pb.awareness.getStates().has(pa.doc.clientID), 5000, 'presence A -> B');
    pb.awareness.setLocalState({ user: { id: 'u2', name: 'Bob' } });
    await waitFor(() => pa.awareness.getStates().has(pb.doc.clientID), 5000, 'presence B -> A');

    await pa.close();
    await waitFor(() => !pb.awareness.getStates().has(pa.doc.clientID), 5000, 'presence cleared');
    await closePeers();
  });

  t('a late joiner on another node receives edits that are not in Postgres yet', async () => {
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    pa.text.insert(0, 'unflushed');
    await sleep(100); // flushMs is 3000, so this is still only in A's memory
    const { rows } = await a.db.query(
      'SELECT count(*)::int AS n FROM document_updates WHERE document_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(0);

    const pb = await join(urlB, editor, id); // B loads an empty DB, then must pull from A
    await waitFor(() => pb.text.toString() === 'unflushed', 5000, 'resync on join');
    await closePeers();
  });

  t('roles are enforced on every node', async () => {
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    pa.text.insert(0, 'ro');
    const vb = await join(urlB, viewer, id);
    await waitFor(() => vb.text.toString() === 'ro', 5000, 'viewer reads on B');
    vb.text.insert(0, 'HACK');
    await sleep(300);
    expect(pa.text.toString()).toBe('ro');
    await closePeers();
  });

  t('a version restored through one node reaches clients attached to another', async () => {
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    const pb = await join(urlB, editor, id);
    pa.text.insert(0, 'good text');
    await waitFor(() => pb.text.toString() === 'good text', 5000, 'initial sync');
    const saved = (await owner.req('POST', `/documents/${id}/versions`, { label: 'good' })).json()
      .version;
    pa.text.insert(pa.text.length, ' plus a mistake');
    await waitFor(() => pb.text.toString() === 'good text plus a mistake', 5000, 'mistake synced');

    // Same session cookie, but the request is served by node B (sessions live in Postgres).
    const viaB = new Client(b.app);
    viaB.cookie = editor.cookie;
    expect(
      (await viaB.req('POST', `/documents/${id}/versions/${saved.id}/restore`)).statusCode,
    ).toBe(200);
    await waitFor(() => pa.text.toString() === 'good text', 5000, 'restore reached node A');
    await waitFor(() => pb.text.toString() === 'good text', 5000, 'restore reached node B');
    await closePeers();
  });

  t(
    'comment notifications reach clients on every node, whichever node took the request',
    async () => {
      const id = await newDoc();
      const pa = await join(urlA, owner, id);
      const pb = await join(urlB, editor, id);

      await owner.req('POST', `/documents/${id}/comments`, { body: 'via A' });
      await waitFor(() => pa.commentPings === 1 && pb.commentPings === 1, 5000, 'ping from A');

      const viaB = new Client(b.app);
      viaB.cookie = editor.cookie;
      await viaB.req('POST', `/documents/${id}/comments`, { body: 'via B' });
      await waitFor(() => pa.commentPings === 2 && pb.commentPings === 2, 5000, 'ping from B');
      await closePeers();
    },
  );

  t('state persists exactly once: no duplicated or lost edits after both nodes flush', async () => {
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    const pb = await join(urlB, editor, id);
    pa.text.insert(0, 'A1 ');
    pb.text.insert(0, 'B1 ');
    await waitFor(() => pa.text.toString() === pb.text.toString() && pa.text.length === 6, 5000);
    const expected = pa.text.toString();
    await closePeers(); // rooms close -> flush + compact on both nodes
    await sleep(300);

    const fresh = await join(urlA, owner, id);
    expect(fresh.text.toString()).toBe(expected);
    await closePeers();
  });

  t('one edit produces exactly one bus update (no echo loops)', async () => {
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    const pb = await join(urlB, editor, id);
    pa.text.insert(0, 'x');
    await waitFor(() => pb.text.toString() === 'x', 5000);
    await sleep(300); // let join-time resync chatter settle

    const mem = busFor.memory;
    if (!mem) return; // counting needs the in-process bus
    let updates = 0;
    mem.drop = (channel, data) => {
      if (channel === channelFor(id)) {
        const d = decoding.createDecoder(data);
        decoding.readVarString(d);
        if (decoding.readVarUint(d) === 0) updates++;
      }
      return false;
    };
    pa.text.insert(1, 'y');
    await waitFor(() => pb.text.toString() === 'xy', 5000);
    await sleep(300);
    mem.drop = null;
    expect(updates).toBe(1);
    await closePeers();
  });

  t('rooms unsubscribe from the bus when their last client leaves', async () => {
    const mem = busFor.memory;
    if (!mem) return;
    const id = await newDoc();
    const pa = await join(urlA, owner, id);
    const pb = await join(urlB, editor, id);
    expect(mem.listenerCount(channelFor(id))).toBe(2);
    await pa.close();
    await waitFor(() => mem.listenerCount(channelFor(id)) === 1, 5000, 'A unsubscribed');
    await pb.close();
    await waitFor(() => mem.listenerCount(channelFor(id)) === 0, 5000, 'B unsubscribed');
  });

  t('losing a node does not disturb clients on the others', async () => {
    const id = await newDoc();
    const c = await setupApp({ sharedWith: a, bus: busFor(), serverId: 'node-c', sync: nodeSync });
    extra.push(c);
    const urlC = await c.listen();
    const pc = await join(urlC, owner, id);
    const pb = await join(urlB, editor, id);
    pc.text.insert(0, 'before crash. ');
    await waitFor(() => pb.text.toString() === 'before crash. ', 5000);

    await pc.close();
    await c.close(); // node C goes away
    extra.splice(extra.indexOf(c), 1);

    pb.text.insert(pb.text.length, 'after crash.');
    await sleep(200);
    const late = await join(urlA, owner, id);
    await waitFor(() => late.text.toString() === 'before crash. after crash.', 5000, 'late joiner');
    await closePeers();
  });
});

describe('cluster resilience to message loss (in-memory bus)', () => {
  let bus: InMemoryBus;
  let a: TestCtx, b: TestCtx;
  let urlA: string, urlB: string;
  let owner: Client, editor: Client;
  let wsId: string;
  const peers: Peer[] = [];
  const nodeSync = { flushMs: 3000, compactEvery: 1000, reauthMs: 60_000 };

  beforeAll(async () => {
    bus = new InMemoryBus();
    a = await setupApp({ bus, serverId: 'loss-a', sync: nodeSync });
    b = await setupApp({ sharedWith: a, bus, serverId: 'loss-b', sync: nodeSync });
    urlA = await a.listen();
    urlB = await b.listen();
    owner = await new Client(a.app).login('owner@example.com');
    editor = await new Client(a.app).login('editor@example.com');
    wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
  });
  afterAll(async () => {
    await Promise.all(peers.splice(0).map((p) => p.close()));
    await b.close();
    await a.close();
  });

  it('nodes that missed updates during a bus outage converge after the bus reconnects', async () => {
    const id: string = (await owner.req('POST', `/workspaces/${wsId}/documents`, {})).json()
      .document.id;
    await owner.req('PUT', `/documents/${id}/shares`, {
      email: 'editor@example.com',
      role: 'editor',
    });
    const pa = await Peer.connect(`${urlA}/ws/docs/${id}`, { cookie: owner.cookie });
    const pb = await Peer.connect(`${urlB}/ws/docs/${id}`, { cookie: editor.cookie });
    peers.push(pa, pb);
    pa.text.insert(0, 'synced ');
    await waitFor(() => pb.text.toString() === 'synced ', 5000);

    bus.drop = () => true; // outage: every cross-node message is lost
    pa.text.insert(pa.text.length, 'A-during-outage ');
    pb.text.insert(pb.text.length, 'B-during-outage ');
    await sleep(300);
    expect(pa.text.toString()).not.toContain('B-during-outage'); // genuinely diverged

    bus.drop = null;
    bus.simulateReconnect(); // what RedisBus does when its subscriber connection comes back
    await waitFor(
      () =>
        pa.text.toString() === pb.text.toString() &&
        pa.text.toString().includes('A-during-outage') &&
        pa.text.toString().includes('B-during-outage'),
      5000,
      'convergence after reconnect',
    );
  });
});

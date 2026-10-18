import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSyncOptions, Room, type Conn } from '../src/sync/room.js';
import { loadDocState } from '../src/sync/persistence.js';
import { setupApp, type TestCtx } from './helpers.js';

/**
 * Convergence properties. The generators produce arbitrary interleavings of edits, message
 * deliveries (in any order across clients), disconnects and reconnects; whatever happens, once
 * the network quiesces every replica, the server and the persisted state must be identical.
 */

type Cmd =
  | { kind: 'edit'; client: number; pos: number; text: string; del: number }
  | { kind: 'deliver'; pick: number }
  | { kind: 'disconnect'; client: number }
  | { kind: 'reconnect'; client: number };

const cmdArb = (clients: number): fc.Arbitrary<Cmd> =>
  fc.oneof(
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant('edit' as const),
        client: fc.nat(clients - 1),
        pos: fc.nat(40),
        text: fc.string({ maxLength: 4 }),
        del: fc.nat(3),
      }),
    },
    {
      weight: 6,
      arbitrary: fc.record({ kind: fc.constant('deliver' as const), pick: fc.nat(1000) }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('disconnect' as const),
        client: fc.nat(clients - 1),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('reconnect' as const),
        client: fc.nat(clients - 1),
      }),
    },
  );

function applyEdit(text: Y.Text, c: Extract<Cmd, { kind: 'edit' }>): void {
  if (c.del > 0 && text.length > 0) {
    const from = Math.min(c.pos, text.length - 1);
    text.delete(from, Math.min(c.del, text.length - from));
  }
  if (c.text) text.insert(Math.min(c.pos, text.length), c.text);
}

describe('pure Yjs: replicas converge regardless of update delivery order', () => {
  it('any permutation / duplication of all updates yields the same text', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            client: fc.nat(2),
            pos: fc.nat(30),
            text: fc.string({ maxLength: 4 }),
            del: fc.nat(3),
          }),
          { maxLength: 40 },
        ),
        fc.integer(),
        (edits, seed) => {
          const docs = [0, 1, 2].map(() => new Y.Doc());
          const log: Uint8Array[] = [];
          docs.forEach((d) => d.on('update', (u: Uint8Array) => log.push(u)));
          // Replicas edit independently (fully partitioned)...
          for (const e of edits) applyEdit(docs[e.client]!.getText('t'), { kind: 'edit', ...e });

          // ...then every update is delivered in a shuffled order, with duplicates, to fresh replicas.
          const shuffled = (s: number) => {
            const a = [...log, ...log.slice(0, 5)];
            let x = s | 1;
            for (let i = a.length - 1; i > 0; i--) {
              x = (x * 1103515245 + 12345) & 0x7fffffff;
              const j = x % (i + 1);
              [a[i], a[j]] = [a[j]!, a[i]!];
            }
            return a;
          };
          const r1 = new Y.Doc();
          const r2 = new Y.Doc();
          shuffled(seed).forEach((u) => Y.applyUpdate(r1, u));
          shuffled(seed + 1).forEach((u) => Y.applyUpdate(r2, u));
          // Y.mergeUpdates (used by compaction) must agree with live application too.
          const r3 = new Y.Doc();
          Y.applyUpdate(r3, Y.mergeUpdates(shuffled(seed + 2)));
          const t = r1.getText('t').toString();
          return t === r2.getText('t').toString() && t === r3.getText('t').toString();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('through the server room: relay, reconnect and persistence', () => {
  let ctx: TestCtx;
  let userId: string;
  let wsId: string;

  beforeAll(async () => {
    ctx = await setupApp();
    const { rows: u } = await ctx.db.query(
      "INSERT INTO users (email, name) VALUES ('prop@example.com', 'Prop') RETURNING id",
    );
    userId = u[0].id;
    const { rows: w } = await ctx.db.query(
      'INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id',
      ['prop', userId],
    );
    wsId = w[0].id;
  });
  afterAll(() => ctx.close());

  class FakeClient {
    doc = new Y.Doc();
    inbox: Uint8Array[] = [];
    outbox: Uint8Array[] = [];
    connected = false;
    conn: Conn;
    constructor(private room: Room) {
      this.conn = {
        canEdit: true,
        send: (d) => this.inbox.push(d),
        close: () => undefined,
      };
      this.doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin === this || !this.connected) return; // offline edits are picked up by the handshake
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeUpdate(e, u);
        this.outbox.push(encoding.toUint8Array(e));
      });
    }
    connect(): void {
      this.connected = true;
      this.inbox = [];
      this.outbox = [];
      this.room.addConn(this.conn);
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.outbox.push(encoding.toUint8Array(e));
    }
    disconnect(): void {
      if (!this.connected) return;
      this.connected = false;
      this.room.removeConn(this.conn);
      this.inbox = [];
      this.outbox = [];
    }
    receive(msg: Uint8Array): void {
      const d = decoding.createDecoder(msg);
      if (decoding.readVarUint(d) !== 0) return;
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 0);
      syncProtocol.readSyncMessage(d, reply, this.doc, this);
      if (encoding.length(reply) > 1) this.outbox.push(encoding.toUint8Array(reply));
    }
  }

  const run = async (nClients: number, cmds: Cmd[]): Promise<void> => {
    const { rows } = await ctx.db.query(
      'INSERT INTO documents (workspace_id, created_by) VALUES ($1, $2) RETURNING id',
      [wsId, userId],
    );
    const docId: string = rows[0].id;
    const errors: unknown[] = [];
    const room = new Room(
      docId,
      ctx.db,
      { ...defaultSyncOptions, flushMs: 1, compactEvery: 4 },
      (e) => errors.push(e),
    );
    await room.load();
    const clients = Array.from({ length: nClients }, () => new FakeClient(room));
    clients.forEach((c) => c.connect());

    const step = (pick: number): boolean => {
      const queues: { c: FakeClient; box: 'inbox' | 'outbox' }[] = [];
      for (const c of clients) {
        if (c.inbox.length) queues.push({ c, box: 'inbox' });
        if (c.outbox.length) queues.push({ c, box: 'outbox' });
      }
      if (queues.length === 0) return false;
      const { c, box } = queues[pick % queues.length]!;
      const msg = c[box].shift()!;
      if (box === 'inbox') c.receive(msg);
      else room.handle(c.conn, msg);
      return true;
    };

    for (const cmd of cmds) {
      const c = clients[cmd.kind === 'deliver' ? 0 : cmd.client]!;
      if (cmd.kind === 'edit') applyEdit(c.doc.getText('t'), cmd);
      else if (cmd.kind === 'deliver') step(cmd.pick);
      else if (cmd.kind === 'disconnect') c.disconnect();
      else if (!c.connected) c.connect();
    }
    // Heal the partition and let the network drain.
    clients.forEach((c) => !c.connected && c.connect());
    let guard = 0;
    while (step(guard++)) if (guard > 100_000) throw new Error('network did not quiesce');

    const expected = room.doc.getText('t').toString();
    for (const c of clients) expect(c.doc.getText('t').toString()).toBe(expected);

    await room.close(); // flush + compact, as when the last client leaves
    const reloaded = new Y.Doc();
    await loadDocState(ctx.db, docId, reloaded);
    expect(reloaded.getText('t').toString()).toBe(expected);
    expect(errors).toEqual([]);
  };

  it('3 clients: random edits, ordering, disconnects and reconnects always converge and persist', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb(3), { minLength: 1, maxLength: 60 }), (cmds) =>
        run(3, cmds),
      ),
      { numRuns: 60 },
    );
  });

  it('2 clients, long runs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb(2), { minLength: 50, maxLength: 150 }), (cmds) =>
        run(2, cmds),
      ),
      { numRuns: 25 },
    );
  });
});

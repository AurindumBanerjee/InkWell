import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { Db } from '../db.js';
import type { Bus } from './bus.js';
import { maybeAutoVersion } from '../versions.js';
import { appendUpdate, compact, loadDocState } from './persistence.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** Server-to-server messages on the per-document bus channel. */
const BUS_UPDATE = 0; // a Yjs update (live edit, or a diff answering BUS_SYNC1)
const BUS_AWARENESS = 1; // an awareness update from the origin server's local clients
const BUS_SYNC1 = 2; // "here is my state vector; send me what I'm missing" (join / reconnect)

/** Present when running as one node of a cluster. */
export interface Cluster {
  bus: Bus;
  /** Unique per process; lets a node ignore its own echoes. */
  serverId: string;
}

export const channelFor = (docId: string): string => `inkwell:doc:${docId}`;

export interface SyncOptions {
  /** Debounce window for batching Yjs updates into one DB row. */
  flushMs: number;
  /** Fold the update log into the snapshot once this many rows accumulated... */
  compactEvery: number;
  /** ...or at least this often while a room is open and dirty. */
  compactIntervalMs: number;
  /** How often connections re-check their role against the DB (catches revocations). */
  reauthMs: number;
  /** Minimum age of the latest version before an automatic one is taken when a room closes. */
  versionGapMs: number;
  /** Automatic versions kept per document (manual and restore versions are never pruned). */
  maxAutoVersions: number;
}

export const defaultSyncOptions: SyncOptions = {
  flushMs: 100,
  compactEvery: 200,
  compactIntervalMs: 30_000,
  reauthMs: 15_000,
  versionGapMs: 10 * 60_000,
  maxAutoVersions: 100,
};

export interface Conn {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
  canEdit: boolean;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<Conn>();
  closing: Promise<void> | null = null;

  private awarenessIds = new Map<Conn, Set<number>>();
  private pending: Uint8Array[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private compactTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private sinceCompact = 0;
  private unsubscribe: (() => Promise<void>) | null = null;
  private offReconnect: (() => void) | null = null;

  constructor(
    readonly id: string,
    private db: Db,
    private opts: SyncOptions,
    private onError: (err: unknown) => void,
    private cluster?: Cluster,
  ) {
    this.awareness.setLocalState(null); // the server itself has no presence
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin as Conn | null);
      // 'load' = already durable. 'bus' = originated on another node, which persists it; persisting
      // here too would double-write every edit and re-publishing would loop forever.
      if (origin === 'load' || origin === 'bus') return;
      this.queue(update);
      this.publish(BUS_UPDATE, update);
    });
    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const conn = origin as Conn | null;
        const owned = conn && this.awarenessIds.get(conn);
        if (owned) {
          added.forEach((c) => owned.add(c));
          removed.forEach((c) => owned.delete(c));
        }
        const changed = [...added, ...updated, ...removed];
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(enc), null);
        // Share presence asserted by our own clients (or removed because they left). Never relay
        // 'bus' echoes, and never relay local 'timeout' expiries: a node that merely missed a
        // heartbeat must not evict a client that is alive on another node.
        if (origin === 'close' || (conn && this.awarenessIds.has(conn))) {
          this.publish(
            BUS_AWARENESS,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
          );
        }
      },
    );
  }

  async load(): Promise<void> {
    if (this.cluster) {
      // Subscribe BEFORE reading Postgres: anything published from now on reaches us, anything
      // older is either already durable (in the DB read below) or recovered by resync().
      this.unsubscribe = await this.cluster.bus.subscribe(channelFor(this.id), (d) =>
        this.onBus(d),
      );
      this.offReconnect = this.cluster.bus.onReconnect(() => this.resync());
    }
    try {
      await loadDocState(this.db, this.id, this.doc);
    } catch (err) {
      await this.detach(); // don't leak the subscription of a room that never came up
      throw err;
    }
    this.resync();
    this.compactTimer = setInterval(() => {
      if (this.sinceCompact > 0) void this.runCompact();
    }, this.opts.compactIntervalMs);
    this.compactTimer.unref();
  }

  addConn(conn: Conn): void {
    this.conns.add(conn);
    this.awarenessIds.set(conn, new Set());
    // Kick off the handshake: send our state vector, then current presence.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.send(encoding.toUint8Array(enc));
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      conn.send(encoding.toUint8Array(aenc));
    }
  }

  /** Returns true when the room is now empty and should be torn down. */
  removeConn(conn: Conn): boolean {
    const ids = this.awarenessIds.get(conn);
    this.awarenessIds.delete(conn);
    this.conns.delete(conn);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], 'close');
    return this.conns.size === 0;
  }

  /**
   * Asks every other node hosting this document for what we are missing. Needed because pub/sub
   * only delivers messages sent after we subscribed: edits made on another node in the last
   * flush window are not in Postgres yet, and a Redis outage can drop messages outright.
   */
  resync(): void {
    this.publish(BUS_SYNC1, Y.encodeStateVector(this.doc));
  }

  private onBus(data: Uint8Array): void {
    try {
      const d = decoding.createDecoder(data);
      const from = decoding.readVarString(d);
      if (from === this.cluster?.serverId) return;
      const type = decoding.readVarUint(d);
      const payload = decoding.readVarUint8Array(d);
      if (type === BUS_UPDATE) {
        Y.applyUpdate(this.doc, payload, 'bus');
      } else if (type === BUS_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, 'bus');
      } else if (type === BUS_SYNC1) {
        const diff = Y.encodeStateAsUpdate(this.doc, payload);
        if (diff.length > 2) this.publish(BUS_UPDATE, diff); // [0,0] is the empty update
        const mine = [...this.awarenessIds.values()].flatMap((s) => [...s]);
        if (mine.length > 0) {
          this.publish(
            BUS_AWARENESS,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, mine),
          );
        }
      }
    } catch (err) {
      this.onError(err); // a malformed peer message must never take the room down
    }
  }

  private publish(type: number, payload: Uint8Array): void {
    if (!this.cluster) return;
    const enc = encoding.createEncoder();
    encoding.writeVarString(enc, this.cluster.serverId);
    encoding.writeVarUint(enc, type);
    encoding.writeVarUint8Array(enc, payload);
    this.cluster.bus
      .publish(channelFor(this.id), encoding.toUint8Array(enc))
      .catch((err) => this.onError(err));
  }

  /** Handles one binary protocol message from a connection. Throws on malformed input. */
  handle(conn: Conn, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      const sub = decoding.readVarUint(decoder);
      if (sub === syncProtocol.messageYjsSyncStep1) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncStep1(decoder, enc, this.doc);
        conn.send(encoding.toUint8Array(enc));
      } else if (
        sub === syncProtocol.messageYjsSyncStep2 ||
        sub === syncProtocol.messageYjsUpdate
      ) {
        // Role enforcement: read-only connections may receive state but never write it.
        if (!conn.canEdit) return;
        const apply =
          sub === syncProtocol.messageYjsSyncStep2
            ? syncProtocol.readSyncStep2
            : syncProtocol.readUpdate;
        apply(decoder, this.doc, conn);
      } else {
        throw new Error(`unknown sync message ${sub}`);
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        conn,
      );
    } else {
      throw new Error(`unknown message type ${type}`);
    }
  }

  /** Persists anything pending, then folds the log into the snapshot. */
  async close(): Promise<void> {
    if (this.compactTimer) clearInterval(this.compactTimer);
    await this.detach(); // stop applying peer traffic to a doc we are about to destroy
    await this.flush();
    await this.runCompact();
    try {
      await maybeAutoVersion(
        this.db,
        this.id,
        this.doc,
        this.opts.versionGapMs,
        this.opts.maxAutoVersions,
      );
    } catch (err) {
      this.onError(err); // history is best-effort; never block teardown on it
    }
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Current Markdown content. */
  text(): string {
    return this.doc.getText('content').toString();
  }

  private async detach(): Promise<void> {
    this.offReconnect?.();
    this.offReconnect = null;
    const unsub = this.unsubscribe;
    this.unsubscribe = null;
    await unsub?.().catch((err) => this.onError(err));
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.writing = this.writing.then(async () => {
      if (this.pending.length === 0) return;
      const batch = this.pending;
      this.pending = [];
      try {
        await appendUpdate(this.db, this.id, Y.mergeUpdates(batch));
        this.sinceCompact += batch.length;
      } catch (err) {
        this.pending = [...batch, ...this.pending]; // keep for retry, order preserved
        this.onError(err);
        return;
      }
      if (this.sinceCompact >= this.opts.compactEvery) await this.runCompact();
    });
    await this.writing;
  }

  private async runCompact(): Promise<void> {
    try {
      await compact(this.db, this.id);
      this.sinceCompact = 0;
    } catch (err) {
      this.onError(err);
    }
  }

  private queue(update: Uint8Array): void {
    this.pending.push(update);
    this.flushTimer ??= setTimeout(() => void this.flush(), this.opts.flushMs);
  }

  private broadcast(data: Uint8Array, except: Conn | null): void {
    for (const c of this.conns) if (c !== except) c.send(data);
  }
}

/** One live Room per document per process; loads lazily and tears down when the last client leaves. */
export class RoomManager {
  private rooms = new Map<string, Promise<Room>>();

  constructor(
    private db: Db,
    private opts: SyncOptions,
    private onError: (err: unknown) => void,
    private cluster?: Cluster,
  ) {}

  async join(docId: string, conn: Conn): Promise<Room> {
    for (;;) {
      const existing = this.rooms.get(docId);
      if (!existing) break;
      const room = await existing.catch(() => null);
      if (room?.closing) await room.closing;
      else if (room) {
        room.addConn(conn);
        return room;
      }
      if (this.rooms.get(docId) === existing) this.rooms.delete(docId);
    }
    const created = (async () => {
      const room = new Room(docId, this.db, this.opts, this.onError, this.cluster);
      await room.load();
      return room;
    })();
    this.rooms.set(docId, created);
    const room = await created.catch((err) => {
      this.rooms.delete(docId);
      throw err;
    });
    room.addConn(conn);
    return room;
  }

  leave(room: Room, conn: Conn): void {
    if (!room.removeConn(conn) || room.closing) return;
    room.closing = room.close().finally(() => {
      if (room.conns.size === 0) this.rooms.delete(room.id);
    });
  }

  get size(): number {
    return this.rooms.size;
  }

  /**
   * Runs `fn` against the live room for a document using a server-side pseudo connection, so
   * REST-triggered changes (e.g. restoring a version) get the same treatment as a client edit:
   * broadcast to local sockets, published to other nodes, persisted. Joining also resyncs with
   * peers, so the room reflects edits other nodes have not flushed yet (up to a short delay).
   */
  async withRoom<T>(docId: string, fn: (room: Room, conn: Conn) => Promise<T> | T): Promise<T> {
    const conn: Conn = { canEdit: true, send: () => undefined, close: () => undefined };
    const room = await this.join(docId, conn);
    try {
      return await fn(room, conn);
    } finally {
      this.leave(room, conn);
    }
  }

  /** Cheap load figures for /healthz; no document ids, so safe to expose unauthenticated. */
  async stats(): Promise<{ rooms: number; conns: number }> {
    const rooms = (
      await Promise.all([...this.rooms.values()].map((p) => p.catch(() => null)))
    ).filter((r): r is Room => r !== null);
    return { rooms: rooms.length, conns: rooms.reduce((n, r) => n + r.conns.size, 0) };
  }

  async closeAll(): Promise<void> {
    const rooms = await Promise.all([...this.rooms.values()].map((p) => p.catch(() => null)));
    await Promise.all(
      rooms.map((r) => {
        if (!r) return;
        for (const c of r.conns) c.close(1001, 'server shutting down');
        return (r.closing ??= r.close());
      }),
    );
    this.rooms.clear();
  }
}

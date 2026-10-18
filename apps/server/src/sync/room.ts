import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { Db } from '../db.js';
import { appendUpdate, compact, loadDocState } from './persistence.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface SyncOptions {
  /** Debounce window for batching Yjs updates into one DB row. */
  flushMs: number;
  /** Fold the update log into the snapshot once this many rows accumulated... */
  compactEvery: number;
  /** ...or at least this often while a room is open and dirty. */
  compactIntervalMs: number;
  /** How often connections re-check their role against the DB (catches revocations). */
  reauthMs: number;
}

export const defaultSyncOptions: SyncOptions = {
  flushMs: 100,
  compactEvery: 200,
  compactIntervalMs: 30_000,
  reauthMs: 15_000,
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

  constructor(
    readonly id: string,
    private db: Db,
    private opts: SyncOptions,
    private onError: (err: unknown) => void,
  ) {
    this.awareness.setLocalState(null); // the server itself has no presence
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin as Conn | null);
      if (origin !== 'load') this.queue(update);
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
      },
    );
  }

  async load(): Promise<void> {
    await loadDocState(this.db, this.id, this.doc);
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
    if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    return this.conns.size === 0;
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
    await this.flush();
    await this.runCompact();
    this.awareness.destroy();
    this.doc.destroy();
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
      const room = new Room(docId, this.db, this.opts, this.onError);
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

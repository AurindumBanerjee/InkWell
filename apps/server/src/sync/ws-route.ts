import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { loadDocument } from '../routes/documents.js';
import { canEdit } from '../permissions.js';
import { HttpError } from '../errors.js';
import { Room, RoomManager, type Conn, type SyncOptions } from './room.js';

/** Application close codes (4000-4999 are reserved for apps; clients must not auto-reconnect on 44xx). */
export const CLOSE = {
  badMessage: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
} as const;

const uuid = z.string().uuid();

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data)
    ? new Uint8Array(Buffer.concat(data))
    : new Uint8Array(data as ArrayBuffer | Buffer);

export function registerSyncRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  rooms: RoomManager,
  opts: SyncOptions,
): void {
  app.get('/ws/docs/:id', { websocket: true }, (socket: WebSocket, req) => {
    // Attach the listener synchronously: messages can arrive while we're still awaiting the DB.
    const backlog: Uint8Array[] = [];
    let room: Room | null = null;
    let closed = false;
    const timers: NodeJS.Timeout[] = [];

    const conn: Conn = {
      canEdit: false,
      send: (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
      },
      close: (code, reason) => socket.close(code, reason),
    };

    const dispatch = (data: Uint8Array): void => {
      try {
        room!.handle(conn, data);
      } catch (err) {
        req.log.warn({ err }, 'bad sync message');
        socket.close(CLOSE.badMessage, 'malformed message');
      }
    };

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return socket.close(CLOSE.badMessage, 'binary frames only');
      if (room) dispatch(toBytes(data));
      else backlog.push(toBytes(data));
    });

    socket.on('close', () => {
      closed = true;
      timers.forEach(clearInterval);
      if (room) rooms.leave(room, conn);
    });
    socket.on('error', () => socket.terminate());

    void (async () => {
      // Browsers always send Origin on WebSocket handshakes; this blocks cross-site hijacking.
      const origin = req.headers.origin;
      if (origin && origin !== config.WEB_ORIGIN)
        return socket.close(CLOSE.forbidden, 'bad origin');
      if (!req.user) return socket.close(CLOSE.unauthenticated, 'authentication required');
      const user = req.user;

      const parsed = uuid.safeParse((req.params as { id: string }).id);
      if (!parsed.success) return socket.close(CLOSE.notFound, 'document not found');
      const docId = parsed.data;

      try {
        const { role } = await loadDocument(db, docId, user.id);
        conn.canEdit = canEdit(role);
      } catch (err) {
        if (err instanceof HttpError) return socket.close(CLOSE.notFound, 'document not found');
        throw err;
      }
      if (closed) return;

      room = await rooms.join(docId, conn);
      if (closed) {
        rooms.leave(room, conn);
        return;
      }
      for (const m of backlog.splice(0)) dispatch(m);

      // Re-check access periodically so revoking a share also cuts live connections.
      timers.push(
        setInterval(() => {
          loadDocument(db, docId, user.id).then(
            ({ role }) => {
              conn.canEdit = canEdit(role);
            },
            (err) => {
              if (err instanceof HttpError) socket.close(CLOSE.forbidden, 'access revoked');
            },
          );
        }, opts.reauthMs),
      );
      // Liveness: drop connections that stop answering pings so rooms don't leak.
      let alive = true;
      socket.on('pong', () => (alive = true));
      timers.push(
        setInterval(() => {
          if (!alive) return socket.terminate();
          alive = false;
          socket.ping();
        }, 30_000),
      );
    })().catch((err) => {
      req.log.error({ err }, 'ws setup failed');
      socket.close(1011, 'internal error');
    });
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { canEdit } from '../permissions.js';
import type { RoomManager, SyncOptions } from '../sync/room.js';
import { createVersion, getVersion, listVersions, replaceText } from '../versions.js';
import { loadDocument } from './documents.js';

const uuid = z.string().uuid();
const createBody = z.object({ label: z.string().trim().min(1).max(200).optional() });

export function registerVersionRoutes(
  app: FastifyInstance,
  db: Db,
  rooms: RoomManager,
  opts: SyncOptions,
): void {
  const docId = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);

  app.get('/documents/:id/versions', async (req) => {
    const user = requireUser(req);
    const { doc } = await loadDocument(db, docId(req), user.id);
    return { versions: await listVersions(db, doc.id) };
  });

  app.get('/documents/:id/versions/:vid', async (req) => {
    const user = requireUser(req);
    const { doc } = await loadDocument(db, docId(req), user.id);
    const vid = uuid.parse((req.params as { vid: string }).vid);
    const version = await getVersion(db, doc.id, vid);
    if (!version) throw new HttpError(404, 'version not found');
    return { version };
  });

  app.post('/documents/:id/versions', async (req, reply) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, docId(req), user.id);
    if (!canEdit(role)) throw new HttpError(403, 'read-only access');
    const { label } = createBody.parse(req.body ?? {});
    const id = await rooms.withRoom(doc.id, (room) =>
      createVersion(
        db,
        doc.id,
        { kind: 'manual', label: label ?? null, userId: user.id, doc: room.doc },
        opts.maxAutoVersions,
      ),
    );
    return reply.code(201).send({ version: await getVersion(db, doc.id, id) });
  });

  // Restore = one ordinary edit on the live document (diff against the current text), preceded by a
  // safety version of what is being replaced, so a restore can itself be undone from history.
  app.post('/documents/:id/versions/:vid/restore', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, docId(req), user.id);
    if (!canEdit(role)) throw new HttpError(403, 'read-only access');
    const version = await getVersion(db, doc.id, uuid.parse((req.params as { vid: string }).vid));
    if (!version) throw new HttpError(404, 'version not found');

    await rooms.withRoom(doc.id, async (room, conn) => {
      await createVersion(
        db,
        doc.id,
        { kind: 'restore', label: 'Before restore', userId: user.id, doc: room.doc },
        opts.maxAutoVersions,
      );
      replaceText(room.doc.getText('content'), version.text, conn);
      await room.flush();
    });
    return { ok: true };
  });
}

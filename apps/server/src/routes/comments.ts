import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { requireUser } from '../app.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { canEdit, canManage } from '../permissions.js';
import type { RoomManager } from '../sync/room.js';
import { loadDocument } from './documents.js';

const uuid = z.string().uuid();
const anchor = z.string().min(1).max(400);

const createBody = z
  .object({
    body: z.string().trim().min(1).max(4000),
    parentId: uuid.optional(),
    anchorStart: anchor.optional(),
    anchorEnd: anchor.optional(),
    quoted: z.string().max(500).optional(),
  })
  .refine((b) => (b.anchorStart === undefined) === (b.anchorEnd === undefined), {
    message: 'anchorStart and anchorEnd must be given together',
  })
  .refine((b) => !b.parentId || b.anchorStart === undefined, {
    message: 'replies cannot have their own anchor',
  });

const patchBody = z
  .object({ body: z.string().trim().min(1).max(4000).optional(), resolved: z.boolean().optional() })
  .refine((b) => b.body !== undefined || b.resolved !== undefined, {
    message: 'nothing to update',
  });

/** Rejects anchors that are not valid base64-encoded Yjs relative positions. */
function assertAnchor(b64: string): void {
  try {
    const bytes = Buffer.from(b64, 'base64');
    // Canonical base64 and a byte-exact round trip: lenient decoders would otherwise accept junk.
    if (bytes.toString('base64') !== b64) throw new Error('not canonical base64');
    const rel = Y.decodeRelativePosition(new Uint8Array(bytes));
    if (!Buffer.from(Y.encodeRelativePosition(rel)).equals(bytes)) throw new Error('round trip');
  } catch {
    throw new HttpError(400, 'invalid anchor');
  }
}

interface CommentRow {
  id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  body: string;
  anchor_start: string | null;
  anchor_end: string | null;
  quoted_text: string | null;
  resolved_at: Date | null;
  created_at: Date;
  edited_at: Date | null;
}

const SELECT = `SELECT c.id, c.parent_id, c.author_id, u.name AS author_name, c.body, c.anchor_start,
                       c.anchor_end, c.quoted_text, c.resolved_at, c.created_at, c.edited_at
                  FROM comments c LEFT JOIN users u ON u.id = c.author_id`;

export function registerCommentRoutes(app: FastifyInstance, db: Db, rooms: RoomManager): void {
  const docId = (req: { params: unknown }) => uuid.parse((req.params as { id: string }).id);
  const load = async (id: string, docIdValue: string): Promise<CommentRow> => {
    const { rows } = await db.query<CommentRow>(
      `${SELECT} WHERE c.id = $1 AND c.document_id = $2`,
      [id, docIdValue],
    );
    if (!rows[0]) throw new HttpError(404, 'comment not found');
    return rows[0];
  };

  app.get('/documents/:id/comments', async (req) => {
    const user = requireUser(req);
    const { doc } = await loadDocument(db, docId(req), user.id);
    const { rows } = await db.query<CommentRow>(
      `${SELECT} WHERE c.document_id = $1 ORDER BY c.created_at, c.id`,
      [doc.id],
    );
    return { comments: rows };
  });

  // Anyone who can see the document can comment on it, including read-only viewers.
  app.post('/documents/:id/comments', async (req, reply) => {
    const user = requireUser(req);
    const { doc } = await loadDocument(db, docId(req), user.id);
    const b = createBody.parse(req.body);
    if (b.anchorStart) {
      assertAnchor(b.anchorStart);
      assertAnchor(b.anchorEnd!);
    }
    if (b.parentId) {
      const parent = await load(b.parentId, doc.id);
      if (parent.parent_id) throw new HttpError(400, 'replies cannot be nested');
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO comments (document_id, parent_id, author_id, body, anchor_start, anchor_end, quoted_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        doc.id,
        b.parentId ?? null,
        user.id,
        b.body,
        b.anchorStart ?? null,
        b.anchorEnd ?? null,
        b.quoted ?? null,
      ],
    );
    await rooms.notifyComments(doc.id);
    return reply.code(201).send({ comment: await load(rows[0]!.id, doc.id) });
  });

  app.patch('/documents/:id/comments/:cid', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, docId(req), user.id);
    const comment = await load(uuid.parse((req.params as { cid: string }).cid), doc.id);
    const b = patchBody.parse(req.body);

    if (b.body !== undefined) {
      if (comment.author_id !== user.id)
        throw new HttpError(403, 'only the author can edit a comment');
      await db.query('UPDATE comments SET body = $2, edited_at = now() WHERE id = $1', [
        comment.id,
        b.body,
      ]);
    }
    if (b.resolved !== undefined) {
      if (comment.parent_id) throw new HttpError(400, 'resolve the thread, not a reply');
      if (!canEdit(role) && comment.author_id !== user.id) {
        throw new HttpError(403, 'only editors or the thread author can resolve');
      }
      await db.query(
        `UPDATE comments SET resolved_at = CASE WHEN $2 THEN now() END,
                             resolved_by = CASE WHEN $2 THEN $3::uuid END WHERE id = $1`,
        [comment.id, b.resolved, user.id],
      );
    }
    await rooms.notifyComments(doc.id);
    return { comment: await load(comment.id, doc.id) };
  });

  app.delete('/documents/:id/comments/:cid', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, docId(req), user.id);
    const comment = await load(uuid.parse((req.params as { cid: string }).cid), doc.id);
    if (comment.author_id !== user.id && !canManage(role)) {
      throw new HttpError(403, 'only the author or an owner can delete a comment');
    }
    await db.query('DELETE FROM comments WHERE id = $1', [comment.id]); // replies cascade
    await rooms.notifyComments(doc.id);
    return { ok: true };
  });
}

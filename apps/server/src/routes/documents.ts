import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import type { Db } from '../db.js';
import { indexTitle } from '../search.js';
import { HttpError } from '../errors.js';
import {
  canEdit,
  canManage,
  canView,
  effectiveRole,
  type Role,
  type ShareRole,
} from '../permissions.js';
import { workspaceRole } from './workspaces.js';

const uuid = z.string().uuid();
const createBody = z.object({ title: z.string().trim().min(1).max(200).default('Untitled') });
const patchBody = z.object({ title: z.string().trim().min(1).max(200) });
const shareBody = z.object({ email: z.string().email(), role: z.enum(['editor', 'viewer']) });

interface DocRow {
  id: string;
  workspace_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

/** Loads a live document plus the caller's effective role; 404 (not 403) when invisible. */
export async function loadDocument(
  db: Db,
  docId: string,
  userId: string,
): Promise<{ doc: DocRow; role: Role }> {
  const { rows } = await db.query<DocRow>(
    `SELECT id, workspace_id, title, created_at, updated_at
       FROM documents WHERE id = $1 AND deleted_at IS NULL`,
    [docId],
  );
  const doc = rows[0];
  if (!doc) throw new HttpError(404, 'document not found');
  const wsRole = await workspaceRole(db, doc.workspace_id, userId);
  const share = await db.query<{ role: ShareRole }>(
    'SELECT role FROM document_shares WHERE document_id = $1 AND user_id = $2',
    [docId, userId],
  );
  const role = effectiveRole(wsRole, share.rows[0]?.role ?? null);
  if (role === null || !canView(role)) throw new HttpError(404, 'document not found');
  return { doc, role };
}

const idParam = (req: { params: unknown }): string => uuid.parse((req.params as { id: string }).id);

export function registerDocumentRoutes(app: FastifyInstance, db: Db): void {
  app.get('/workspaces/:id/documents', async (req) => {
    const user = requireUser(req);
    const id = idParam(req);
    if (!(await workspaceRole(db, id, user.id))) throw new HttpError(404, 'workspace not found');
    const { rows } = await db.query(
      `SELECT id, title, created_at, updated_at FROM documents
        WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [id],
    );
    return { documents: rows };
  });

  // Documents shared directly with the caller (may live in workspaces they don't belong to).
  app.get('/documents/shared-with-me', async (req) => {
    const user = requireUser(req);
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.updated_at, s.role FROM document_shares s
         JOIN documents d ON d.id = s.document_id
        WHERE s.user_id = $1 AND d.deleted_at IS NULL ORDER BY d.updated_at DESC`,
      [user.id],
    );
    return { documents: rows };
  });

  app.post('/workspaces/:id/documents', async (req, reply) => {
    const user = requireUser(req);
    const id = idParam(req);
    const role = await workspaceRole(db, id, user.id);
    if (!role) throw new HttpError(404, 'workspace not found');
    if (!canEdit(role)) throw new HttpError(403, 'viewers cannot create documents');
    const { title } = createBody.parse(req.body ?? {});
    const { rows } = await db.query(
      `INSERT INTO documents (workspace_id, title, created_by) VALUES ($1, $2, $3)
       RETURNING id, title, created_at, updated_at`,
      [id, title, user.id],
    );
    await indexTitle(db, rows[0].id);
    return reply.code(201).send({ document: rows[0] });
  });

  app.get('/documents/:id', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, idParam(req), user.id);
    return { document: doc, role };
  });

  app.patch('/documents/:id', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, idParam(req), user.id);
    if (!canEdit(role)) throw new HttpError(403, 'read-only access');
    const { title } = patchBody.parse(req.body);
    const { rows } = await db.query(
      `UPDATE documents SET title = $2, updated_at = now() WHERE id = $1
       RETURNING id, title, created_at, updated_at`,
      [doc.id, title],
    );
    await indexTitle(db, doc.id);
    return { document: rows[0] };
  });

  app.delete('/documents/:id', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, idParam(req), user.id);
    if (!canManage(role)) throw new HttpError(403, 'only owners can delete documents');
    await db.query('UPDATE documents SET deleted_at = now() WHERE id = $1', [doc.id]);
    return { ok: true };
  });

  app.get('/documents/:id/shares', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, idParam(req), user.id);
    if (!canManage(role)) throw new HttpError(403, 'only owners can view shares');
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, s.role FROM document_shares s
         JOIN users u ON u.id = s.user_id WHERE s.document_id = $1 ORDER BY u.name`,
      [doc.id],
    );
    return { shares: rows };
  });

  app.put('/documents/:id/shares', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, idParam(req), user.id);
    if (!canManage(role)) throw new HttpError(403, 'only owners can share documents');
    const body = shareBody.parse(req.body);
    const target = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [body.email],
    );
    const targetId = target.rows[0]?.id;
    if (!targetId) throw new HttpError(404, 'no user with that email (they must sign in once)');
    await db.query(
      `INSERT INTO document_shares (document_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [doc.id, targetId, body.role],
    );
    return { ok: true };
  });

  app.delete('/documents/:id/shares/:userId', async (req) => {
    const user = requireUser(req);
    const { doc, role } = await loadDocument(db, idParam(req), user.id);
    if (!canManage(role)) throw new HttpError(403, 'only owners can unshare documents');
    const { userId } = req.params as { userId: string };
    await db.query('DELETE FROM document_shares WHERE document_id = $1 AND user_id = $2', [
      doc.id,
      uuid.parse(userId),
    ]);
    return { ok: true };
  });
}

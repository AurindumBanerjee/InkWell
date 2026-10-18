import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import type { Role } from '../permissions.js';

export async function workspaceRole(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<Role | null> {
  const { rows } = await db.query<{ role: Role }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}

const uuid = z.string().uuid();
const createBody = z.object({ name: z.string().trim().min(1).max(100) });
const memberBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'editor', 'viewer']),
});

export function registerWorkspaceRoutes(app: FastifyInstance, db: Db): void {
  app.get('/workspaces', async (req) => {
    const user = requireUser(req);
    const { rows } = await db.query(
      `SELECT w.id, w.name, m.role FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1 ORDER BY w.created_at`,
      [user.id],
    );
    return { workspaces: rows };
  });

  app.post('/workspaces', async (req, reply) => {
    const user = requireUser(req);
    const { name } = createBody.parse(req.body);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const ws = await client.query<{ id: string }>(
        'INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id',
        [name, user.id],
      );
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [ws.rows[0]!.id, user.id],
      );
      await client.query('COMMIT');
      return reply.code(201).send({ workspace: { id: ws.rows[0]!.id, name, role: 'owner' } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/workspaces/:id/members', async (req) => {
    const user = requireUser(req);
    const id = uuid.parse((req.params as { id: string }).id);
    if (!(await workspaceRole(db, id, user.id))) throw new HttpError(404, 'workspace not found');
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.avatar_url, m.role FROM workspace_members m
         JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.name`,
      [id],
    );
    return { members: rows };
  });

  app.put('/workspaces/:id/members', async (req) => {
    const user = requireUser(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const role = await workspaceRole(db, id, user.id);
    if (!role) throw new HttpError(404, 'workspace not found');
    if (role !== 'owner') throw new HttpError(403, 'only owners can manage members');
    const body = memberBody.parse(req.body);
    const target = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [body.email],
    );
    const targetId = target.rows[0]?.id;
    if (!targetId) throw new HttpError(404, 'no user with that email (they must sign in once)');
    if (targetId === user.id && body.role !== 'owner') {
      const others = await db.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' AND user_id <> $2",
        [id, user.id],
      );
      if (others.rowCount === 0) throw new HttpError(409, 'workspace must keep at least one owner');
    }
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [id, targetId, body.role],
    );
    return { ok: true };
  });
}

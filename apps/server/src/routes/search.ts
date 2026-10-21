import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import type { Db } from '../db.js';
import { searchDocuments } from '../search.js';

const query = z.object({
  q: z.string().trim().min(1).max(200),
  workspaceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export function registerSearchRoutes(app: FastifyInstance, db: Db): void {
  // Supports web-search syntax: "exact phrase", -excluded, or. Hit markers are \u0001 ... \u0002.
  app.get('/search', async (req) => {
    const user = requireUser(req);
    const { q, workspaceId, limit, offset } = query.parse(req.query);
    const results = await searchDocuments(db, user.id, q, { workspaceId, limit, offset });
    return { results };
  });
}

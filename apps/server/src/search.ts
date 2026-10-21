import * as Y from 'yjs';
import type { Db } from './db.js';
import { loadDocState } from './sync/persistence.js';

/** Control characters that cannot appear in Markdown text; the UI renders hits without any HTML. */
export const HIT_START = '\u0001';
export const HIT_END = '\u0002';

/** Stores the document's current plain text; a no-op write is skipped so tsvectors aren't rebuilt. */
export async function indexBody(db: Db, docId: string, body: string): Promise<void> {
  await db.query(
    `INSERT INTO document_search (document_id, title, body)
     SELECT id, title, $2 FROM documents WHERE id = $1
     ON CONFLICT (document_id) DO UPDATE
       SET body = EXCLUDED.body, indexed_at = now()
     WHERE document_search.body IS DISTINCT FROM EXCLUDED.body`,
    [docId, body],
  );
}

/** Copies the current title from `documents` (used on create and rename). */
export async function indexTitle(db: Db, docId: string): Promise<void> {
  await db.query(
    `INSERT INTO document_search (document_id, title)
     SELECT id, title FROM documents WHERE id = $1
     ON CONFLICT (document_id) DO UPDATE
       SET title = EXCLUDED.title, indexed_at = now()
     WHERE document_search.title IS DISTINCT FROM EXCLUDED.title`,
    [docId],
  );
}

export interface SearchHit {
  id: string;
  title: string;
  workspace_id: string;
  updated_at: Date;
  rank: number;
  /** Excerpt with HIT_START / HIT_END around matched terms. */
  snippet: string;
}

export interface SearchOptions {
  workspaceId?: string;
  limit: number;
  offset: number;
}

const HEADLINE_OPTIONS = `StartSel=${HIT_START}, StopSel=${HIT_END}, MaxFragments=2, MaxWords=24, MinWords=8, FragmentDelimiter= … `;

/**
 * The search query, exported so benchmarks can EXPLAIN exactly what production runs.
 *
 * Shape (chosen by bench/search-lab.ts, which verified the variants return identical results):
 * rank and access-filter first and keep only the requested page, then build the expensive
 * snippets for just those rows. Forcing the GIN index to run first was measurably worse for
 * common terms, so the planner is left to choose.
 */
export const SEARCH_SQL = `WITH page AS (
       SELECT d.id, d.title, d.workspace_id, d.updated_at,
              ts_rank_cd(s.tsv, websearch_to_tsquery('english', $2)) AS rank
         FROM document_search s
         JOIN documents d ON d.id = s.document_id
        WHERE s.tsv @@ websearch_to_tsquery('english', $2)
          AND d.deleted_at IS NULL
          AND ($4::uuid IS NULL OR d.workspace_id = $4::uuid)
          AND (EXISTS (SELECT 1 FROM workspace_members m
                        WHERE m.workspace_id = d.workspace_id AND m.user_id = $1)
            OR EXISTS (SELECT 1 FROM document_shares sh
                        WHERE sh.document_id = d.id AND sh.user_id = $1))
        ORDER BY rank DESC, d.updated_at DESC, d.id
        LIMIT $5 OFFSET $6)
     SELECT p.id, p.title, p.workspace_id, p.updated_at, p.rank,
            ts_headline('english', s.body, websearch_to_tsquery('english', $2), $3) AS snippet
       FROM page p
       JOIN document_search s ON s.document_id = p.id
      ORDER BY p.rank DESC, p.updated_at DESC, p.id`;

export const searchParams = (userId: string, q: string, opts: SearchOptions): unknown[] => [
  userId,
  q,
  HEADLINE_OPTIONS,
  opts.workspaceId ?? null,
  opts.limit,
  opts.offset,
];

/**
 * Ranked search over every document the user can open: a member of its workspace, or shared with
 * directly. Access is part of the WHERE clause, so an unreadable document can never contribute a
 * row, a rank or a snippet.
 */
export async function searchDocuments(
  db: Db,
  userId: string,
  q: string,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const { rows } = await db.query<SearchHit>(SEARCH_SQL, searchParams(userId, q, opts));
  return rows;
}

/** Rebuilds the search body of every document from its persisted CRDT state. */
export async function reindexAll(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM documents WHERE deleted_at IS NULL',
  );
  for (const { id } of rows) {
    const doc = new Y.Doc();
    await loadDocState(db, id, doc);
    await indexBody(db, id, doc.getText('content').toString());
    doc.destroy();
  }
  return rows.length;
}

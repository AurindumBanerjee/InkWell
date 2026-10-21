import * as Y from 'yjs';
import type { Db } from './db.js';

export type VersionKind = 'manual' | 'auto' | 'restore';

export interface VersionSummary {
  id: string;
  kind: VersionKind;
  label: string | null;
  created_at: Date;
  created_by_name: string | null;
  preview: string;
  chars: number;
}

/**
 * Replaces the content of `ytext` with `next` as a minimal edit (common prefix/suffix kept).
 * Restoring through ordinary CRDT operations, rather than swapping the whole document state,
 * means concurrent editors keep their cursors and their edits merge with the restore.
 */
export function replaceText(ytext: Y.Text, next: string, origin?: unknown): void {
  const cur = ytext.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let end = 0;
  while (
    end < cur.length - start &&
    end < next.length - start &&
    cur[cur.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  ytext.doc?.transact(() => {
    if (cur.length - start - end > 0) ytext.delete(start, cur.length - start - end);
    if (next.length - start - end > 0) ytext.insert(start, next.slice(start, next.length - end));
  }, origin);
}

export interface NewVersion {
  kind: VersionKind;
  label?: string | null;
  userId?: string | null;
  doc: Y.Doc;
}

/** Stores a version of `doc`'s current content; auto versions beyond `keepAuto` are pruned. */
export async function createVersion(
  db: Db,
  docId: string,
  v: NewVersion,
  keepAuto = 100,
): Promise<string> {
  const text = v.doc.getText('content').toString();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO document_versions (document_id, created_by, kind, label, state, text_content)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      docId,
      v.userId ?? null,
      v.kind,
      v.label ?? null,
      Buffer.from(Y.encodeStateAsUpdate(v.doc)),
      text,
    ],
  );
  if (v.kind === 'auto') {
    // Manual and restore versions are deliberate and never pruned.
    await db.query(
      `DELETE FROM document_versions WHERE document_id = $1 AND kind = 'auto' AND id NOT IN (
         SELECT id FROM document_versions WHERE document_id = $1 AND kind = 'auto'
          ORDER BY created_at DESC, id DESC LIMIT $2)`,
      [docId, keepAuto],
    );
  }
  return rows[0]!.id;
}

/**
 * Snapshots the document if it changed since the latest version and that version is at least
 * `gapMs` old. Serialised per document, so several nodes closing the same room don't both insert.
 */
export async function maybeAutoVersion(
  db: Db,
  docId: string,
  doc: Y.Doc,
  gapMs: number,
  keepAuto: number,
): Promise<boolean> {
  const text = doc.getText('content').toString();
  if (text.length === 0) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [docId]);
    const { rows } = await client.query<{ text_content: string; age_ms: string }>(
      `SELECT text_content, (extract(epoch FROM now() - created_at) * 1000)::bigint AS age_ms
         FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [docId],
    );
    const latest = rows[0];
    if (latest && (latest.text_content === text || Number(latest.age_ms) < gapMs)) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      `INSERT INTO document_versions (document_id, kind, state, text_content)
       VALUES ($1, 'auto', $2, $3)`,
      [docId, Buffer.from(Y.encodeStateAsUpdate(doc)), text],
    );
    await client.query(
      `DELETE FROM document_versions WHERE document_id = $1 AND kind = 'auto' AND id NOT IN (
         SELECT id FROM document_versions WHERE document_id = $1 AND kind = 'auto'
          ORDER BY created_at DESC, id DESC LIMIT $2)`,
      [docId, keepAuto],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listVersions(db: Db, docId: string): Promise<VersionSummary[]> {
  const { rows } = await db.query(
    `SELECT v.id, v.kind, v.label, v.created_at, u.name AS created_by_name,
            left(v.text_content, 120) AS preview, length(v.text_content) AS chars
       FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.document_id = $1 ORDER BY v.created_at DESC, v.id DESC LIMIT 200`,
    [docId],
  );
  return rows;
}

export async function getVersion(
  db: Db,
  docId: string,
  versionId: string,
): Promise<(VersionSummary & { text: string }) | null> {
  const { rows } = await db.query(
    `SELECT v.id, v.kind, v.label, v.created_at, u.name AS created_by_name,
            left(v.text_content, 120) AS preview, length(v.text_content) AS chars,
            v.text_content AS text
       FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.document_id = $1 AND v.id = $2`,
    [docId, versionId],
  );
  return rows[0] ?? null;
}

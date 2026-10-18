import * as Y from 'yjs';
import type { Db } from '../db.js';

/** Appends one (already merged) Yjs update to the durable log. */
export async function appendUpdate(db: Db, docId: string, update: Uint8Array): Promise<void> {
  await db.query('INSERT INTO document_updates (document_id, update) VALUES ($1, $2)', [
    docId,
    Buffer.from(update),
  ]);
  await db.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docId]);
}

/** Rebuilds the current document: snapshot first, then the updates logged after it. */
export async function loadDocState(db: Db, docId: string, into: Y.Doc): Promise<number> {
  const snap = await db.query<{ state: Buffer; last_update_id: string }>(
    'SELECT state, last_update_id FROM document_snapshots WHERE document_id = $1',
    [docId],
  );
  const after = snap.rows[0]?.last_update_id ?? '0';
  const updates = await db.query<{ update: Buffer }>(
    'SELECT update FROM document_updates WHERE document_id = $1 AND id > $2 ORDER BY id',
    [docId, after],
  );
  Y.transact(
    into,
    () => {
      if (snap.rows[0]) Y.applyUpdate(into, snap.rows[0].state);
      for (const r of updates.rows) Y.applyUpdate(into, r.update);
    },
    'load',
  );
  return updates.rows.length;
}

/**
 * Folds the update log into the snapshot and deletes the folded rows. Works purely on persisted
 * bytes (Y.mergeUpdates needs no in-memory doc) under a per-document advisory lock, so it stays
 * correct when several server processes compact the same document.
 */
export async function compact(db: Db, docId: string): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [docId]);
    const snap = await client.query<{ state: Buffer; last_update_id: string }>(
      'SELECT state, last_update_id FROM document_snapshots WHERE document_id = $1',
      [docId],
    );
    const after = snap.rows[0]?.last_update_id ?? '0';
    const rows = await client.query<{ id: string; update: Buffer }>(
      'SELECT id, update FROM document_updates WHERE document_id = $1 AND id > $2 ORDER BY id',
      [docId, after],
    );
    if (rows.rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }
    const parts = rows.rows.map((r) => new Uint8Array(r.update));
    if (snap.rows[0]) parts.unshift(new Uint8Array(snap.rows[0].state));
    const merged = Y.mergeUpdates(parts);
    const lastId = rows.rows[rows.rows.length - 1]!.id;
    await client.query(
      `INSERT INTO document_snapshots (document_id, state, last_update_id) VALUES ($1, $2, $3)
       ON CONFLICT (document_id) DO UPDATE
         SET state = EXCLUDED.state, last_update_id = EXCLUDED.last_update_id, updated_at = now()`,
      [docId, Buffer.from(merged), lastId],
    );
    await client.query('DELETE FROM document_updates WHERE document_id = $1 AND id <= $2', [
      docId,
      lastId,
    ]);
    await client.query('COMMIT');
    return rows.rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

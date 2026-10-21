import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/**
 * Applies pending `NNN_name.sql` files in order, each in its own transaction.
 * `prefix` namespaces the recorded names, so a separate set of migrations (the AI build's tables,
 * applied only when the AI flag is on) can live in its own directory without clashing.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, prefix = ''): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent migrators (e.g. several replicas booting at once).
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const name = `${prefix}${file}`;
      if (done.has(name)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${(err as Error).message}`);
      }
      applied.push(name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

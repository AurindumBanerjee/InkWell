/**
 * Prepares the data a load test needs and writes bench/.generated/seed.json:
 * one user with a session, one workspace, and N documents.
 *
 *   npx tsx bench/k6/seed.ts [docs=100]
 *
 * Writes straight to the cluster's Postgres (localhost:5433), so no OAuth app is involved.
 * Every virtual user shares this one session; per-connection auth cost (one session lookup and
 * one document/role lookup) is the same as for distinct users.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DOCS = Number(process.argv[2] ?? 100);
const DB = process.env.DEMO_DATABASE_URL ?? 'postgres://inkwell:inkwell@localhost:5433/inkwell';

const db = new pg.Client({ connectionString: DB });
await db.connect();
const suffix = randomBytes(4).toString('hex');
const user = (
  await db.query("INSERT INTO users (email, name) VALUES ($1, 'Load') RETURNING id", [
    `load-${suffix}@example.com`,
  ])
).rows[0];
const ws = (
  await db.query('INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id', [
    'load',
    user.id,
  ])
).rows[0];
await db.query("INSERT INTO workspace_members VALUES ($1, $2, 'owner')", [ws.id, user.id]);

const token = randomBytes(32).toString('base64url');
await db.query(
  "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '6 hours')",
  [createHash('sha256').update(token).digest('hex'), user.id],
);
const docs = (
  await db.query(
    `INSERT INTO documents (workspace_id, title, created_by)
     SELECT $1, 'load-' || g, $2 FROM generate_series(1, $3::int) g RETURNING id`,
    [ws.id, user.id, DOCS],
  )
).rows.map((r) => r.id as string);
await db.end();

const out = path.resolve(import.meta.dirname, '../.generated/seed.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ cookie: `inkwell_sid=${token}`, docs }, null, 2));
console.log(`seeded ${docs.length} documents -> ${path.relative(process.cwd(), out)}`);

/**
 * Compares formulations of the search query on the same corpus and checks that each returns
 * exactly the same ordered results as the production query before timing it.
 *
 *   npx tsx bench/search-lab.ts [docs=20000] [wordsPerDoc=250]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createDb } from '../apps/server/src/db.js';
import { migrate } from '../apps/server/src/migrate.js';
import { SEARCH_SQL, searchParams } from '../apps/server/src/search.js';
import { loadCorpus } from './corpus.js';

const DOCS = Number(process.argv[2] ?? 20_000);
const WORDS = Number(process.argv[3] ?? 250);

const TSQ = "websearch_to_tsquery('english', $2)";
const AUTHZ = `d.deleted_at IS NULL
        AND ($4::uuid IS NULL OR d.workspace_id = $4::uuid)
        AND (EXISTS (SELECT 1 FROM workspace_members m
                      WHERE m.workspace_id = d.workspace_id AND m.user_id = $1)
          OR EXISTS (SELECT 1 FROM document_shares sh
                      WHERE sh.document_id = d.id AND sh.user_id = $1))`;

/** The query production used before the lab picked V2 (kept so the comparison stays reproducible). */
const PREVIOUS_SQL = `WITH q AS (SELECT websearch_to_tsquery('english', $2) AS query)
     SELECT d.id, d.title, d.workspace_id, d.updated_at,
            ts_rank_cd(s.tsv, q.query) AS rank,
            ts_headline('english', s.body, q.query, $3) AS snippet
       FROM q, document_search s
       JOIN documents d ON d.id = s.document_id
      WHERE s.tsv @@ q.query AND ${AUTHZ}
      ORDER BY rank DESC, d.updated_at DESC, d.id
      LIMIT $5 OFFSET $6`;

const variants: { name: string; sql: string }[] = [
  { name: 'V0 previous production query (CTE, one pass)', sql: PREVIOUS_SQL },
  {
    name: 'V1 inline tsquery, one pass',
    sql: `SELECT d.id, d.title, d.workspace_id, d.updated_at,
            ts_rank_cd(s.tsv, ${TSQ}) AS rank,
            ts_headline('english', s.body, ${TSQ}, $3) AS snippet
       FROM document_search s JOIN documents d ON d.id = s.document_id
      WHERE s.tsv @@ ${TSQ} AND ${AUTHZ}
      ORDER BY rank DESC, d.updated_at DESC, d.id
      LIMIT $5 OFFSET $6`,
  },
  {
    name: 'V2 rank + authz first, headline only for the page (current production)',
    sql: SEARCH_SQL,
  },
  {
    name: 'V3 index-first (materialised hits), headline only for the page',
    sql: `WITH hits AS MATERIALIZED (
            SELECT document_id, ts_rank_cd(tsv, ${TSQ}) AS rank
              FROM document_search WHERE tsv @@ ${TSQ}),
          page AS (
            SELECT d.id, d.title, d.workspace_id, d.updated_at, h.rank
              FROM hits h JOIN documents d ON d.id = h.document_id
             WHERE ${AUTHZ}
             ORDER BY h.rank DESC, d.updated_at DESC, d.id
             LIMIT $5 OFFSET $6)
          SELECT p.id, p.title, p.workspace_id, p.updated_at, p.rank,
                 ts_headline('english', s.body, ${TSQ}, $3) AS snippet
            FROM page p JOIN document_search s ON s.document_id = p.id
           ORDER BY p.rank DESC, p.updated_at DESC, p.id`,
  },
];

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const dir = await mkdtemp(path.join(os.tmpdir(), 'inkwell-lab-'));
const port = await freePort();
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: false,
});
await pg.initialise();
await pg.start();
await pg.createDatabase('lab');
const db = createDb(`postgres://postgres:postgres@localhost:${port}/lab`);

try {
  await migrate(db);
  console.log(`loading ${DOCS} documents x ${WORDS} words ...`);
  const corpus = await loadCorpus(db, DOCS, WORDS);
  console.log(`loaded in ${corpus.loadSeconds.toFixed(0)}s`);
  const run = (sql: string, q: string) =>
    db.query(sql, searchParams(corpus.user, q, { limit: 20, offset: 0 }));

  // 1. Equivalence: every variant must return the same ordered ids as production.
  let compared = 0;
  for (const w of corpus.queries) {
    const base = (await run(variants[0]!.sql, w.q)).rows.map((r) => r.id);
    for (const v of variants.slice(1)) {
      const got = (await run(v.sql, w.q)).rows.map((r) => r.id);
      if (JSON.stringify(got) !== JSON.stringify(base)) {
        throw new Error(`${v.name} differs from production for query ${w.q}`);
      }
    }
    compared++;
  }
  console.log(`equivalence: all variants return identical ordered results for ${compared} queries`);

  // 2. Timing.
  const results: Record<string, Record<string, { p50: number; p95: number }>> = {};
  for (const v of variants) {
    for (const w of corpus.queries.slice(0, 30)) await run(v.sql, w.q); // warm up
    const byKind = new Map<string, number[]>();
    const all: number[] = [];
    for (const w of corpus.queries) {
      const s = performance.now();
      await run(v.sql, w.q);
      const ms = performance.now() - s;
      all.push(ms);
      (byKind.get(w.kind) ?? byKind.set(w.kind, []).get(w.kind)!).push(ms);
    }
    const stat = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return {
        p50: +percentile(sorted, 0.5).toFixed(2),
        p95: +percentile(sorted, 0.95).toFixed(2),
      };
    };
    results[v.name] = {
      overall: stat(all),
      ...Object.fromEntries([...byKind].map(([k, x]) => [k, stat(x)])),
    };
    console.log(`\n${v.name}`);
    for (const [k, s] of Object.entries(results[v.name]!)) {
      console.log(
        `  ${k.padEnd(16)} p50=${String(s.p50).padStart(7)}ms  p95=${String(s.p95).padStart(7)}ms`,
      );
    }
  }

  mkdirSync(path.resolve(import.meta.dirname, 'results'), { recursive: true });
  const file = path.resolve(import.meta.dirname, `results/search-lab-${DOCS}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        documents: DOCS,
        wordsPerDocument: WORDS,
        tableSize: corpus.tableSize,
        ginIndexSize: corpus.ginIndexSize,
        queries: corpus.queries.length,
        equivalentResultsVerified: compared,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
} finally {
  await db.end().catch(() => undefined);
  await pg.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);

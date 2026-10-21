/**
 * Search latency benchmark: the real access-filtered search query over a synthetic corpus,
 * with and without the GIN index.
 *
 *   npx tsx bench/search-bench.ts [docs=20000] [wordsPerDoc=250]
 *
 * Self-contained: boots a throwaway embedded Postgres, so it never touches a dev database.
 * Results go to bench/results/search-<docs>.json and are summarised on stdout.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createDb } from '../apps/server/src/db.js';
import { migrate } from '../apps/server/src/migrate.js';
import { SEARCH_SQL, searchDocuments, searchParams } from '../apps/server/src/search.js';
import { loadCorpus, MEMBER_OF, VOCAB, WORKSPACES } from './corpus.js';

const DOCS = Number(process.argv[2] ?? 20_000);
const WORDS = Number(process.argv[3] ?? 250);

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

const dir = await mkdtemp(path.join(os.tmpdir(), 'inkwell-bench-'));
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
await pg.createDatabase('bench');
const db = createDb(`postgres://postgres:postgres@localhost:${port}/bench`);

try {
  await migrate(db);
  const version = (await db.query('SHOW server_version')).rows[0].server_version as string;

  // ---- corpus -------------------------------------------------------------------------------
  console.log(`generating ${DOCS} documents x ${WORDS} words ...`);
  const corpus = await loadCorpus(db, DOCS, WORDS);
  const { user, queries, loadSeconds } = corpus;
  const size = { total: corpus.tableSize, idx: corpus.ginIndexSize };
  console.log(`loaded in ${loadSeconds.toFixed(0)}s; table ${size.total}, GIN index ${size.idx}`);

  // ---- queries ------------------------------------------------------------------------------
  const QUERIES = queries.length;

  /** Prints the executed plan for one query, so a number is never reported without knowing why. */
  async function explain(label: string, q: string) {
    const params = searchParams(user, q, { limit: 20, offset: 0 });
    const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${SEARCH_SQL}`, params);
    const plan = rows.map((r) => r['QUERY PLAN'] as string);
    console.log(`
--- plan: ${label}  (query: ${q})`);
    for (const line of plan.filter((l) =>
      /Scan|Join|Sort|Limit|Execution Time|Planning Time/.test(l),
    )) {
      console.log(line.slice(0, 150));
    }
  }

  async function run(label: string) {
    for (const w of queries.slice(0, 40)) {
      await searchDocuments(db, user, w.q, { limit: 20, offset: 0 }); // warm caches
    }
    const all: number[] = [];
    const byKind = new Map<string, number[]>();
    let hits = 0;
    for (const w of queries) {
      const s = performance.now();
      const rows = await searchDocuments(db, user, w.q, { limit: 20, offset: 0 });
      const ms = performance.now() - s;
      hits += rows.length;
      all.push(ms);
      (byKind.get(w.kind) ?? byKind.set(w.kind, []).get(w.kind)!).push(ms);
    }
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return {
        n: s.length,
        p50: +percentile(s, 0.5).toFixed(2),
        p95: +percentile(s, 0.95).toFixed(2),
        max: +s[s.length - 1]!.toFixed(2),
      };
    };
    const result = {
      label,
      overall: stat(all),
      meanHitsPerQuery: +(hits / queries.length).toFixed(1),
      byKind: Object.fromEntries([...byKind].map(([k, v]) => [k, stat(v)])),
    };
    console.log(
      `\n${label}: p50=${result.overall.p50}ms p95=${result.overall.p95}ms max=${result.overall.max}ms`,
    );
    for (const [k, v] of Object.entries(result.byKind)) {
      console.log(
        `  ${k.padEnd(18)} p50=${String(v.p50).padStart(7)}ms  p95=${String(v.p95).padStart(7)}ms`,
      );
    }
    return result;
  }

  if (process.env.EXPLAIN) {
    await explain('rare term, with index', queries[0]!.q);
    await explain('common term, with index', queries[2]!.q);
  }
  const withIndex = await run('with GIN index');
  await db.query('DROP INDEX document_search_tsv_idx');
  await db.query('ANALYZE document_search');
  const withoutIndex = await run('without index (sequential scan)');

  const out = {
    date: new Date().toISOString(),
    hardware: {
      cpu: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
      os: `${os.type()} ${os.release()}`,
    },
    software: { node: process.version, postgres: version },
    dataset: {
      documents: DOCS,
      wordsPerDocument: WORDS,
      vocabulary: VOCAB,
      distribution: 'log-uniform ranks (Zipf-like), synthetic tokens',
      workspaces: WORKSPACES,
      visibleToUser: `${MEMBER_OF}/${WORKSPACES} workspaces (20% of documents)`,
      tableSize: size.total,
      ginIndexSize: size.idx,
      loadSeconds: +loadSeconds.toFixed(1),
    },
    queries: { count: QUERIES, limit: 20, includesAccessFilterAndSnippets: true },
    withIndex,
    withoutIndex,
    note: 'Single client, sequential queries, machine shared with other jobs: indicative, not a capacity claim.',
  };
  mkdirSync(path.resolve(import.meta.dirname, 'results'), { recursive: true });
  const file = path.resolve(import.meta.dirname, `results/search-${DOCS}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
} finally {
  await db.end().catch(() => undefined);
  await pg.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);

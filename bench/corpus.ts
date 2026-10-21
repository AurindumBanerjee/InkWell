/**
 * Shared synthetic corpus for the search benchmarks: Zipf-like vocabulary, many workspaces, and a
 * user who can see 20% of them. Deterministic, so runs are comparable.
 */
import type { Db } from '../apps/server/src/db.js';

export const VOCAB = 50_000;
export const WORKSPACES = 50;
export const MEMBER_OF = 10; // the benchmark user can see 20% of all documents

let seed = 42;
export const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** Letters-only token for a vocabulary rank (avoids stop-words and number tokens). */
export const wordFor = (rank: number): string => {
  let s = '';
  let n = rank + 1;
  while (n > 0) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return `xq${s}`;
};
/** Zipf-like (log-uniform) rank: a few very common words, a long tail of rare ones. */
const zipfRank = (): number => Math.min(VOCAB - 1, Math.floor(Math.exp(rand() * Math.log(VOCAB))));

export interface Corpus {
  user: string;
  queries: { kind: string; q: string }[];
  loadSeconds: number;
  tableSize: string;
  ginIndexSize: string;
}

export async function loadCorpus(
  db: Db,
  docs: number,
  wordsPerDoc: number,
  queryCount = 300,
): Promise<Corpus> {
  const user = (
    await db.query(
      "INSERT INTO users (email, name) VALUES ('bench@example.com', 'Bench') RETURNING id",
    )
  ).rows[0].id as string;
  const wsIds: string[] = [];
  for (let i = 0; i < WORKSPACES; i++) {
    const id = (
      await db.query('INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id', [
        `w${i}`,
        user,
      ])
    ).rows[0].id as string;
    wsIds.push(id);
    if (i < MEMBER_OF) {
      await db.query("INSERT INTO workspace_members VALUES ($1, $2, 'owner')", [id, user]);
    }
  }

  const samplePhrases: string[] = [];
  const t0 = performance.now();
  const BATCH = 500;
  for (let start = 0; start < docs; start += BATCH) {
    const n = Math.min(BATCH, docs - start);
    const ws: string[] = [];
    const titles: string[] = [];
    const bodies: string[] = [];
    for (let i = 0; i < n; i++) {
      const words: string[] = [];
      for (let w = 0; w < wordsPerDoc; w++) words.push(wordFor(zipfRank()));
      if (samplePhrases.length < 200 && rand() < 0.05) {
        const at = Math.floor(rand() * (wordsPerDoc - 2));
        samplePhrases.push(`${words[at]} ${words[at + 1]}`);
      }
      titles.push(`${wordFor(zipfRank())} ${wordFor(zipfRank())}`);
      bodies.push(words.join(' '));
      ws.push(wsIds[(start + i) % WORKSPACES]!);
    }
    const inserted = await db.query(
      `INSERT INTO documents (workspace_id, title, created_by)
       SELECT w, t, $3::uuid FROM unnest($1::uuid[], $2::text[]) AS x(w, t) RETURNING id`,
      [ws, titles, user],
    );
    await db.query(
      `INSERT INTO document_search (document_id, title, body)
       SELECT d, t, b FROM unnest($1::uuid[], $2::text[], $3::text[]) AS x(d, t, b)
       ON CONFLICT (document_id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body`,
      [inserted.rows.map((r) => r.id), titles, bodies],
    );
  }
  await db.query('ANALYZE');
  const loadSeconds = (performance.now() - t0) / 1000;
  const size = (
    await db.query(
      `SELECT pg_size_pretty(pg_total_relation_size('document_search')) AS total,
              pg_size_pretty(pg_relation_size('document_search_tsv_idx')) AS idx`,
    )
  ).rows[0] as { total: string; idx: string };

  const kinds: { kind: string; make: () => string }[] = [
    { kind: 'rare term', make: () => wordFor(20_000 + Math.floor(rand() * 25_000)) },
    { kind: 'medium term', make: () => wordFor(500 + Math.floor(rand() * 3_000)) },
    { kind: 'common term', make: () => wordFor(Math.floor(rand() * 60)) },
    {
      kind: 'two terms (AND)',
      make: () =>
        `${wordFor(300 + Math.floor(rand() * 2_000))} ${wordFor(100 + Math.floor(rand() * 500))}`,
    },
    { kind: 'phrase', make: () => `"${samplePhrases[Math.floor(rand() * samplePhrases.length)]}"` },
  ];
  const queries = Array.from({ length: queryCount }, (_, i) => {
    const k = kinds[i % kinds.length]!;
    return { kind: k.kind, q: k.make() };
  });
  return { user, queries, loadSeconds, tableSize: size.total, ginIndexSize: size.idx };
}

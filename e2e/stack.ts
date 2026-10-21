import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { buildApp } from '../apps/server/src/app.js';
import { createDb } from '../apps/server/src/db.js';
import { migrate } from '../apps/server/src/migrate.js';

/**
 * Self-contained backend for end-to-end runs: a throwaway Postgres plus the real API on :4100.
 * Isolated from the developer's own database and ports (:5432 / :4000).
 */
const API_PORT = 4100;
const WEB_ORIGIN = 'http://localhost:3100';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const dir = await mkdtemp(path.join(os.tmpdir(), 'inkwell-e2e-'));
const pgPort = await freePort();
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port: pgPort,
  persistent: false,
});
await pg.initialise();
await pg.start();
await pg.createDatabase('inkwell');

const databaseUrl = `postgres://postgres:postgres@localhost:${pgPort}/inkwell`;
const db = createDb(databaseUrl);
await migrate(db);
const app = await buildApp({
  config: {
    NODE_ENV: 'test',
    PORT: API_PORT,
    DATABASE_URL: databaseUrl,
    WEB_ORIGIN,
    PUBLIC_URL: `http://localhost:${API_PORT}`,
    ENABLE_DEV_LOGIN: true,
    AI_FEATURES: process.env.AI_FEATURES === 'true',
  },
  db,
});
await app.listen({ port: API_PORT, host: '127.0.0.1' });
console.log(`e2e api ready on :${API_PORT}`);

const shutdown = async (): Promise<void> => {
  await app.close().catch(() => undefined);
  await db.end().catch(() => undefined);
  await pg.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Tests run against a real Postgres. In CI, TEST_DATABASE_URL points at a service container;
 * locally we boot a throwaway embedded cluster so `npm test` needs no setup.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.TEST_DATABASE_URL) return async () => undefined;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'inkwell-pg-'));
  const port = 54329;
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/postgres`;
  return async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
}

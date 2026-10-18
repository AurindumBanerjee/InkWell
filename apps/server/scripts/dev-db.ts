import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** Persistent local Postgres on :5432 for machines without Docker. Data lives in <repo>/.data/pg. */
const databaseDir = path.resolve(import.meta.dirname, '../../../.data/pg');
const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'inkwell',
  password: 'inkwell',
  port: 5432,
  persistent: true,
});

const fresh = !existsSync(path.join(databaseDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('inkwell');
console.log('postgres ready: postgres://inkwell:inkwell@localhost:5432/inkwell');

const stop = async (): Promise<void> => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

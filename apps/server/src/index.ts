import { buildApp } from './app.js';
import { githubProvider } from './auth.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const oauth =
  config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
    ? githubProvider(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET)
    : undefined;
const app = await buildApp({ config, db, oauth });
await app.listen({ port: config.PORT, host: '0.0.0.0' });

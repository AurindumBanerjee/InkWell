import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { reindexAll } from './search.js';

const db = createDb(loadConfig().DATABASE_URL);
console.log(`reindexed ${await reindexAll(db)} documents`);
await db.end();

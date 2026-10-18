import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const db = createDb(loadConfig().DATABASE_URL);
const applied = await migrate(db);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
await db.end();

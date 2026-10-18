import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { OAuthProfile, OAuthProvider } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import type { SyncOptions } from '../src/sync/room.js';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  config: Config;
  /** Starts a real listener on an ephemeral port; returns the ws:// base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

/** Fresh database per test file, so suites are isolated without truncating tables. */
export async function setupApp(
  opts: { oauth?: OAuthProvider; devLogin?: boolean; sync?: Partial<SyncOptions> } = {},
): Promise<TestCtx> {
  const base = process.env.TEST_DATABASE_URL!;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;

  const db = createDb(url.toString());
  await migrate(db);
  const config: Config = {
    NODE_ENV: 'test',
    PORT: 0,
    DATABASE_URL: url.toString(),
    WEB_ORIGIN: 'http://localhost:3000',
    PUBLIC_URL: 'http://localhost:4000',
    ENABLE_DEV_LOGIN: opts.devLogin ?? true,
  };
  const app = await buildApp({ config, db, oauth: opts.oauth, sync: opts.sync });
  return {
    app,
    db,
    config,
    listen: async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      return `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    },
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async login(email: string, name?: string): Promise<this> {
    const res = await this.app.inject({
      method: 'POST',
      url: '/auth/dev-login',
      payload: { email, name },
    });
    this.cookie = String(res.headers['set-cookie']).split(';')[0]!;
    return this;
  }

  req(method: Method, url: string, payload?: object) {
    return this.app.inject({ method, url, payload, headers: { cookie: this.cookie } });
  }
}

export const fakeProfile = (over: Partial<OAuthProfile> = {}): OAuthProfile => ({
  provider: 'fake',
  providerUserId: '42',
  email: 'ada@example.com',
  name: 'Ada',
  avatarUrl: null,
  ...over,
});

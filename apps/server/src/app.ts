import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getSessionUser,
  upsertOAuthUser,
  type OAuthProvider,
  type User,
} from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  oauth?: OAuthProvider;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'authentication required');
  return req.user;
}

const devLoginBody = z.object({ email: z.string().email(), name: z.string().min(1).optional() });

export async function buildApp({ config, db, oauth }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.NODE_ENV === 'development' });
  await app.register(cookie);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.user = await getSessionUser(db, req.cookies[SESSION_COOKIE]);
  });

  // CSRF defence: SameSite=Lax cookie plus an Origin check on state-changing requests.
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== config.WEB_ORIGIN) throw new HttpError(403, 'bad origin');
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: err.issues });
    }
    if (err instanceof HttpError || (err.statusCode && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  const setSession = async (reply: FastifyReply, userId: string): Promise<void> => {
    const { token, expires } = await createSession(db, userId);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      path: '/',
      expires,
    });
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/me', async (req) => ({ user: requireUser(req) }));

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  if (oauth) {
    const redirectUri = `${config.PUBLIC_URL}/auth/${oauth.name}/callback`;
    app.get(`/auth/${oauth.name}`, async (_req, reply) => {
      const state = randomBytes(16).toString('base64url');
      reply.setCookie('inkwell_oauth_state', state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.NODE_ENV === 'production',
        path: '/',
        maxAge: 600,
      });
      return reply.redirect(oauth.authorizeUrl(state, redirectUri));
    });

    app.get(`/auth/${oauth.name}/callback`, async (req, reply) => {
      const { code, state } = req.query as { code?: string; state?: string };
      const expected = req.cookies['inkwell_oauth_state'];
      if (!code || !state || !expected || state !== expected) {
        throw new HttpError(400, 'invalid oauth state');
      }
      reply.clearCookie('inkwell_oauth_state', { path: '/' });
      const user = await upsertOAuthUser(db, await oauth.fetchProfile(code, redirectUri));
      await setSession(reply, user.id);
      return reply.redirect(config.WEB_ORIGIN);
    });
  }

  if (config.ENABLE_DEV_LOGIN) {
    // Test/dev only (refused in production by loadConfig): sign in as any email without OAuth.
    app.post('/auth/dev-login', async (req, reply) => {
      const { email, name } = devLoginBody.parse(req.body);
      const user = await upsertOAuthUser(db, {
        provider: 'dev',
        providerUserId: email.toLowerCase(),
        email,
        name: name ?? email.split('@')[0]!,
        avatarUrl: null,
      });
      await setSession(reply, user.id);
      return { user };
    });
  }

  registerWorkspaceRoutes(app, db);
  registerDocumentRoutes(app, db);
  return app;
}

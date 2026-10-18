import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OAuthProvider } from '../src/auth.js';
import { Client, fakeProfile, setupApp, type TestCtx } from './helpers.js';

const oauth: OAuthProvider = {
  name: 'fake',
  authorizeUrl: (state, redirect) => `https://idp.test/auth?state=${state}&r=${redirect}`,
  fetchProfile: async () => fakeProfile(),
};

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp({ oauth });
});
afterAll(() => ctx.close());

describe('oauth flow', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/auth/fake/callback?code=c&state=evil',
      headers: { cookie: 'inkwell_oauth_state=good' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('signs a new user in, creating a personal workspace, and the session works', async () => {
    const start = await ctx.app.inject({ method: 'GET', url: '/auth/fake' });
    expect(start.statusCode).toBe(302);
    const stateCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const state = stateCookie.split('=')[1]!;

    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/auth/fake/callback?code=abc&state=${state}`,
      headers: { cookie: stateCookie },
    });
    expect(cb.statusCode).toBe(302);
    const cookies = ([] as string[]).concat(cb.headers['set-cookie'] ?? []);
    const sid = cookies.find((c) => c.startsWith('inkwell_sid='))!.split(';')[0]!;

    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: sid } });
    expect(me.json().user.email).toBe('ada@example.com');
    const ws = await ctx.app.inject({
      method: 'GET',
      url: '/workspaces',
      headers: { cookie: sid },
    });
    expect(ws.json().workspaces).toHaveLength(1);
    expect(ws.json().workspaces[0].role).toBe('owner');
  });

  it('logging in again reuses the same user', async () => {
    await new Client(ctx.app).login('ada@example.com');
    const { rows } = await ctx.db.query(
      "SELECT count(*)::int AS n FROM users WHERE email = 'ada@example.com'",
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('sessions', () => {
  it('requires auth', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('logout invalidates the session', async () => {
    const c = await new Client(ctx.app).login('bob@example.com');
    expect((await c.req('GET', '/me')).statusCode).toBe(200);
    await c.req('POST', '/auth/logout');
    expect((await c.req('GET', '/me')).statusCode).toBe(401);
  });

  it('ignores expired sessions', async () => {
    const c = await new Client(ctx.app).login('carol@example.com');
    await ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await c.req('GET', '/me')).statusCode).toBe(401);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const c = await new Client(ctx.app).login('dave@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'x' },
      headers: { cookie: c.cookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('dev-login rejects non-loopback clients', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/dev-login',
      payload: { email: 'x@example.com' },
      remoteAddress: '10.1.2.3',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exposes no dev-login when disabled', async () => {
    const off = await setupApp({ devLogin: false });
    const res = await off.app.inject({
      method: 'POST',
      url: '/auth/dev-login',
      payload: { email: 'a@b.co' },
    });
    expect(res.statusCode).toBe(404);
    await off.close();
  });
});

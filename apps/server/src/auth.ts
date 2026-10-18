import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.js';

export const SESSION_COOKIE = 'inkwell_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export interface OAuthProfile {
  provider: string;
  providerUserId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** Abstracts the identity provider so the callback flow is testable without the network. */
export interface OAuthProvider {
  name: string;
  authorizeUrl(state: string, redirectUri: string): string;
  fetchProfile(code: string, redirectUri: string): Promise<OAuthProfile>;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await db.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    userId,
    expires,
  ]);
  return { token, expires };
}

export async function getSessionUser(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const { rows } = await db.query<User>(
    `SELECT u.id, u.email, u.name, u.avatar_url
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
}

/**
 * Resolves an OAuth profile to a user: existing link first, then an existing user with the same
 * (provider-verified) email, otherwise a new user. Creates a personal workspace for new users.
 */
export async function upsertOAuthUser(db: Db, p: OAuthProfile): Promise<User> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const linked = await client.query<User>(
      `SELECT u.id, u.email, u.name, u.avatar_url FROM oauth_accounts o
         JOIN users u ON u.id = o.user_id
        WHERE o.provider = $1 AND o.provider_user_id = $2`,
      [p.provider, p.providerUserId],
    );
    let user = linked.rows[0];
    if (!user) {
      const byEmail = await client.query<User>(
        'SELECT id, email, name, avatar_url FROM users WHERE lower(email) = lower($1)',
        [p.email],
      );
      user = byEmail.rows[0];
      if (!user) {
        user = (
          await client.query<User>(
            `INSERT INTO users (email, name, avatar_url) VALUES ($1, $2, $3)
             RETURNING id, email, name, avatar_url`,
            [p.email, p.name, p.avatarUrl],
          )
        ).rows[0]!;
        const ws = await client.query<{ id: string }>(
          'INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id',
          [`${p.name}'s workspace`.slice(0, 100), user.id],
        );
        await client.query(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
          [ws.rows[0]!.id, user.id],
        );
      }
      await client.query(
        'INSERT INTO oauth_accounts (provider, provider_user_id, user_id) VALUES ($1, $2, $3)',
        [p.provider, p.providerUserId, user.id],
      );
    }
    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function githubProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    name: 'github',
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async fetchProfile(code, redirectUri) {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) throw new Error('github token exchange failed');
      const headers = { Authorization: `Bearer ${access_token}`, 'User-Agent': 'inkwell' };
      const me = (await (await fetch('https://api.github.com/user', { headers })).json()) as {
        id: number;
        login: string;
        name: string | null;
        avatar_url: string;
      };
      const emails = (await (
        await fetch('https://api.github.com/user/emails', { headers })
      ).json()) as { email: string; primary: boolean; verified: boolean }[];
      const primary = emails.find((e) => e.primary && e.verified);
      if (!primary) throw new Error('no verified primary email on github account');
      return {
        provider: 'github',
        providerUserId: String(me.id),
        email: primary.email,
        name: me.name ?? me.login,
        avatarUrl: me.avatar_url,
      };
    },
  };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { canEdit, canManage, canView, effectiveRole } from '../src/permissions.js';
import { setupApp, type TestCtx } from './helpers.js';

describe('effectiveRole', () => {
  it('is null with no access', () => expect(effectiveRole(null, null)).toBeNull());
  it('takes the highest of workspace and share roles', () => {
    expect(effectiveRole('viewer', 'editor')).toBe('editor');
    expect(effectiveRole('owner', 'viewer')).toBe('owner');
    expect(effectiveRole(null, 'viewer')).toBe('viewer');
  });
  it('maps roles to capabilities', () => {
    expect([canView('viewer'), canEdit('viewer'), canManage('viewer')]).toEqual([
      true,
      false,
      false,
    ]);
    expect([canView('editor'), canEdit('editor'), canManage('editor')]).toEqual([
      true,
      true,
      false,
    ]);
    expect([canView('owner'), canEdit('owner'), canManage('owner')]).toEqual([true, true, true]);
    expect(canView(null)).toBe(false);
  });
});

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => expect(() => loadConfig({})).toThrow());
  it('refuses dev login in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', ENABLE_DEV_LOGIN: 'true' }),
    ).toThrow(/production/);
  });
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).PORT).toBe(4000);
  });
});

describe('migrate', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await setupApp();
  });
  afterAll(() => ctx.close());

  it('is idempotent and records applied migrations', async () => {
    expect(await migrate(ctx.db)).toEqual([]);
    const { rows } = await ctx.db.query('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('001_init.sql');
  });
});

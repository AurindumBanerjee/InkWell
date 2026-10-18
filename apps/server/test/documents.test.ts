import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let owner: Client, stranger: Client, member: Client;
let wsId: string;
let docId: string;

beforeAll(async () => {
  ctx = await setupApp();
  owner = await new Client(ctx.app).login('owner@example.com');
  stranger = await new Client(ctx.app).login('stranger@example.com');
  member = await new Client(ctx.app).login('member@example.com');
  wsId = (await owner.req('GET', '/workspaces')).json().workspaces[0].id;
  const res = await owner.req('POST', `/workspaces/${wsId}/documents`, { title: 'Plan' });
  expect(res.statusCode).toBe(201);
  docId = res.json().document.id;
});
afterAll(() => ctx.close());

const putMember = (c: Client, email: string, role: string) =>
  c.req('PUT', `/workspaces/${wsId}/members`, { email, role });

describe('workspaces', () => {
  it('creates a workspace owned by the caller', async () => {
    const res = await owner.req('POST', '/workspaces', { name: 'Club' });
    expect(res.statusCode).toBe(201);
    expect(res.json().workspace.role).toBe('owner');
  });

  it('validates input', async () => {
    expect((await owner.req('POST', '/workspaces', { name: '' })).statusCode).toBe(400);
  });

  it('hides workspaces from non-members', async () => {
    expect((await stranger.req('GET', `/workspaces/${wsId}/documents`)).statusCode).toBe(404);
    expect((await stranger.req('GET', `/workspaces/${wsId}/members`)).statusCode).toBe(404);
    expect((await stranger.req('POST', `/workspaces/${wsId}/documents`, {})).statusCode).toBe(404);
  });

  it('only owners manage members, and the last owner cannot demote themselves', async () => {
    expect((await putMember(owner, 'member@example.com', 'viewer')).statusCode).toBe(200);
    expect((await putMember(member, 'stranger@example.com', 'viewer')).statusCode).toBe(403);
    expect((await putMember(owner, 'nobody@example.com', 'viewer')).statusCode).toBe(404);
    expect((await putMember(owner, 'owner@example.com', 'editor')).statusCode).toBe(409);
    const members = (await owner.req('GET', `/workspaces/${wsId}/members`)).json().members;
    expect(members).toHaveLength(2);
  });
});

describe('document access control', () => {
  it('viewer members can read but not create, edit or delete', async () => {
    await putMember(owner, 'member@example.com', 'viewer');
    expect((await member.req('GET', `/documents/${docId}`)).json().role).toBe('viewer');
    expect((await member.req('POST', `/workspaces/${wsId}/documents`, {})).statusCode).toBe(403);
    expect((await member.req('PATCH', `/documents/${docId}`, { title: 'x' })).statusCode).toBe(403);
    expect((await member.req('DELETE', `/documents/${docId}`)).statusCode).toBe(403);
  });

  it('non-members get 404 and cannot see the doc', async () => {
    expect((await stranger.req('GET', `/documents/${docId}`)).statusCode).toBe(404);
  });

  it('direct share grants access without workspace membership', async () => {
    const share = (role: string) =>
      owner.req('PUT', `/documents/${docId}/shares`, { email: 'stranger@example.com', role });

    expect((await share('viewer')).statusCode).toBe(200);
    expect((await stranger.req('GET', `/documents/${docId}`)).json().role).toBe('viewer');
    expect((await stranger.req('PATCH', `/documents/${docId}`, { title: 'x' })).statusCode).toBe(
      403,
    );
    expect((await stranger.req('GET', '/documents/shared-with-me')).json().documents).toHaveLength(
      1,
    );

    expect((await share('editor')).statusCode).toBe(200);
    const patched = await stranger.req('PATCH', `/documents/${docId}`, { title: 'Renamed' });
    expect(patched.json().document.title).toBe('Renamed');
    // Editors still can't manage sharing.
    const attempt = await stranger.req('PUT', `/documents/${docId}/shares`, {
      email: 'x@y.co',
      role: 'viewer',
    });
    expect(attempt.statusCode).toBe(403);
    expect((await stranger.req('GET', `/documents/${docId}/shares`)).statusCode).toBe(403);
  });

  it('lists and revokes shares', async () => {
    const shares = (await owner.req('GET', `/documents/${docId}/shares`)).json().shares;
    expect(shares).toHaveLength(1);
    const del = await owner.req('DELETE', `/documents/${docId}/shares/${shares[0].id}`);
    expect(del.statusCode).toBe(200);
    expect((await stranger.req('GET', `/documents/${docId}`)).statusCode).toBe(404);
  });

  it('soft-deletes documents (owner only) and hides them', async () => {
    const created = await owner.req('POST', `/workspaces/${wsId}/documents`, { title: 'Temp' });
    const id = created.json().document.id;
    expect((await owner.req('DELETE', `/documents/${id}`)).statusCode).toBe(200);
    expect((await owner.req('GET', `/documents/${id}`)).statusCode).toBe(404);
    const list = (await owner.req('GET', `/workspaces/${wsId}/documents`)).json().documents;
    expect(list.map((d: { id: string }) => d.id)).not.toContain(id);
  });

  it('rejects malformed ids', async () => {
    expect((await owner.req('GET', '/documents/not-a-uuid')).statusCode).toBe(400);
  });
});

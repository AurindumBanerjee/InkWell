/**
 * End-to-end check of the Docker cluster (docker-compose.cluster.yml):
 *   1. cross-node sync: peers on three different nodes converge, and we time the propagation;
 *   2. sticky routing: five clients going through nginx for one document all land on ONE node.
 *
 * Authentication: this script writes a user + session straight into Postgres (it has DB access),
 * so no OAuth app is needed and dev-login stays disabled in the cluster.
 *
 *   npm run cluster:demo -w apps/server
 */
import { createHash, randomBytes } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import pg from 'pg';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import * as Y from 'yjs';

const DB = process.env.DEMO_DATABASE_URL ?? 'postgres://inkwell:inkwell@localhost:5433/inkwell';
const NODES = {
  a: 'http://localhost:4001',
  b: 'http://localhost:4002',
  c: 'http://localhost:4003',
};
const FRONT = 'http://localhost:4000';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000, what = 'condition'): Promise<number> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
  return performance.now() - t0;
}

class Peer {
  doc = new Y.Doc();
  synced = false;
  ws: WebSocket;
  constructor(base: string, docId: string, cookie: string) {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws/docs/${docId}`, {
      headers: { cookie, origin: 'http://localhost:3000' },
    });
    this.ws.on('open', () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.ws.on('message', (d: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(d));
      if (decoding.readVarUint(dec) !== 0) return;
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 0);
      const t = syncProtocol.readSyncMessage(dec, reply, this.doc, this);
      if (t === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(reply) > 1) this.ws.send(encoding.toUint8Array(reply));
    });
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, u);
      this.ws.send(encoding.toUint8Array(e));
    });
  }
  get text(): string {
    return this.doc.getText('content').toString();
  }
  insert(s: string): void {
    const t = this.doc.getText('content');
    t.insert(t.length, s);
  }
}

const db = new pg.Client({ connectionString: DB });
await db.connect();
const suffix = randomBytes(4).toString('hex');
const user = (
  await db.query("INSERT INTO users (email, name) VALUES ($1, 'Demo') RETURNING id", [
    `demo-${suffix}@example.com`,
  ])
).rows[0];
const ws = (
  await db.query('INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id', [
    'demo',
    user.id,
  ])
).rows[0];
await db.query("INSERT INTO workspace_members VALUES ($1, $2, 'owner')", [ws.id, user.id]);
const token = randomBytes(32).toString('base64url');
await db.query(
  "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
  [createHash('sha256').update(token).digest('hex'), user.id],
);
const cookie = `inkwell_sid=${token}`;
const newDoc = async (): Promise<string> =>
  (
    await db.query(
      'INSERT INTO documents (workspace_id, created_by) VALUES ($1, $2) RETURNING id',
      [ws.id, user.id],
    )
  ).rows[0].id;
const stats = async (base: string) =>
  (await (await fetch(`${base}/healthz`)).json()) as { node: string; rooms: number; conns: number };

console.log('--- 1. cross-node sync (clients connect directly to nodes a, b, c)');
{
  const id = await newDoc();
  const [pa, pb, pc] = [
    new Peer(NODES.a, id, cookie),
    new Peer(NODES.b, id, cookie),
    new Peer(NODES.c, id, cookie),
  ];
  await waitFor(() => pa.synced && pb.synced && pc.synced, 10000, 'initial sync');
  const hops: number[] = [];
  for (const [from, tos, label] of [
    [pa, [pb, pc], 'a -> b,c'],
    [pb, [pa, pc], 'b -> a,c'],
    [pc, [pa, pb], 'c -> a,b'],
  ] as const) {
    for (let i = 0; i < 20; i++) {
      const marker = `${label}#${i};`;
      from.insert(marker);
      hops.push(await waitFor(() => tos.every((p) => p.text.includes(marker)), 5000, marker));
    }
  }
  await waitFor(() => pa.text === pb.text && pb.text === pc.text, 5000, 'full convergence');
  hops.sort((x, y) => x - y);
  const q = (p: number) => hops[Math.min(hops.length - 1, Math.floor(p * hops.length))]!.toFixed(1);
  console.log(
    `converged: ${pa.text.length} chars identical on 3 nodes; ` +
      `propagation to all other nodes over ${hops.length} edits: p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(1)}ms`,
  );
  [pa, pb, pc].forEach((p) => p.ws.close());
}

console.log('--- 2. sticky routing (5 clients via nginx :4000, one document)');
{
  const id = await newDoc();
  const peers = Array.from({ length: 5 }, () => new Peer(FRONT, id, cookie));
  await waitFor(() => peers.every((p) => p.synced), 10000, 'sync via nginx');
  const per = await Promise.all(
    Object.entries(NODES).map(async ([k, u]) => [k, await stats(u)] as const),
  );
  for (const [k, s] of per)
    console.log(`node ${k} (${s.node.slice(0, 8)}): rooms=${s.rooms} conns=${s.conns}`);
  const hosting = per.filter(([, s]) => s.conns > 0);
  const total = per.reduce((n, [, s]) => n + s.conns, 0);
  const ok = hosting.length === 1 && total >= 5;
  console.log(
    ok ? 'PASS: all clients of the document landed on a single node' : 'FAIL: clients were split',
  );
  peers[0]!.insert('hello via nginx');
  await waitFor(() => peers.every((p) => p.text === 'hello via nginx'), 5000, 'fan-out');
  peers.forEach((p) => p.ws.close());
  if (!ok) process.exitCode = 1;
}

await db.end();
process.exit(process.exitCode ?? 0);

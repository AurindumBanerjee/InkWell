// Sanity check: the lite client's raw-byte scan recovers the marker from a real Yjs update frame.
import assert from 'node:assert/strict';
import { createClient, createLiteClient } from './protocol.mjs';

const frames = [];
const sender = createClient({ onSend: (m) => frames.push(m), onMarker: () => {}, clientId: 4242 });
const sent = [];
for (let i = 0; i < 5; i++) {
  const now = 1_700_000_000_000 + i * 17;
  sent.push(now % 100_000_000);
  sender.typeMarker(now);
}
assert.equal(frames.length, 5);

const got = [];
const receiver = createLiteClient({
  onSend: () => {},
  onMarker: (n) => got.push(n),
  clientId: 4343,
});
for (const f of frames) receiver.handle(f);
assert.deepEqual(got, sent, 'every marker found exactly once, in order');

// History replay (sync step 2) must not count as live latency.
const step2 = new Uint8Array([0, 1, ...frames[0].slice(2)]);
const before = got.length;
receiver.handle(step2);
assert.equal(got.length, before, 'step 2 frames are ignored');
console.log(`lite client ok: recovered ${got.length} markers from real update frames`);

// Source for bench/k6/dist/protocol.js (bundled with esbuild because k6 cannot import npm packages).
// A minimal Yjs sync client: speaks the same y-websocket protocol as the browser.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;
const MARKER = /~(\d{8})#/g;

/**
 * @param {{ onSend: (m: Uint8Array) => void, onMarker: (ts8: number) => void }} cb
 *   onSend   - called with each protocol message to put on the socket
 *   onMarker - called with the 8-digit timestamp of every latency marker that arrives from a peer
 */
export function createClient({ onSend, onMarker }) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  let inserts = 0;

  // Local edits -> sync "update" messages.
  doc.on('update', (update, origin) => {
    if (origin === doc) return; // came from the server
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    onSend(encoding.toUint8Array(enc));
  });

  // Remote edits -> look for markers in the inserted text.
  text.observe((event) => {
    if (event.transaction.origin !== doc) return;
    for (const d of event.delta) {
      if (typeof d.insert !== 'string') continue;
      for (const m of d.insert.matchAll(MARKER)) onMarker(Number(m[1]));
    }
  });

  return {
    /** First message of the handshake: our (empty) state vector. */
    step1() {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      return encoding.toUint8Array(enc);
    },
    /** Feed one binary message from the server; replies (e.g. sync step 2) go out via onSend. */
    handle(data) {
      const dec = decoding.createDecoder(data);
      if (decoding.readVarUint(dec) !== MSG_SYNC) return; // awareness etc. are not needed here
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, reply, doc, doc);
      if (encoding.length(reply) > 1) onSend(encoding.toUint8Array(reply));
    },
    /** Type a latency marker carrying the current time; keeps the document from growing without bound. */
    typeMarker(nowMs) {
      const ts8 = String(nowMs % 100_000_000).padStart(8, '0');
      text.insert(text.length, `~${ts8}# `);
      if (++inserts % 25 === 0 && text.length > 1500) text.delete(0, 1000);
    },
    length: () => text.length,
    destroy: () => doc.destroy(),
  };
}

// Source for bench/k6/dist/protocol.js (bundled with esbuild because k6 cannot import npm packages).
// A minimal Yjs sync client: speaks the same y-websocket protocol as the browser.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MSG_SYNC = 0;
const MARKER = /~(\d{8})#/g;

/**
 * @param {{ onSend: (m: Uint8Array) => void, onMarker: (ts8: number) => void, clientId?: number }} cb
 *   onSend   - called with each protocol message to put on the socket
 *   onMarker - called with the 8-digit timestamp of every LIVE latency marker from a peer. Markers
 *              that arrive as part of the initial state transfer (sync step 2) are history, typed
 *              long before this client joined, so they are skipped: counting them would report the
 *              document's age as "latency".
 *   clientId - unique Yjs client id (virtual users must not share one)
 */
export function createClient({ onSend, onMarker, clientId }) {
  const doc = new Y.Doc();
  if (clientId) doc.clientID = clientId;
  let replaying = false; // true while applying the server's initial state transfer
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
    if (replaying || event.transaction.origin !== doc) return;
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
      // Peek at the sync sub-type without consuming it: step 2 is the initial state transfer.
      const peek = decoding.createDecoder(data);
      decoding.readVarUint(peek);
      replaying = decoding.readVarUint(peek) === syncProtocol.messageYjsSyncStep2;
      try {
        syncProtocol.readSyncMessage(dec, reply, doc, doc);
      } finally {
        replaying = false;
      }
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

/** Calls cb(ts8) for every latency marker (`~dddddddd#`) found in the raw bytes of a frame. */
function findMarkers(data, cb) {
  for (let i = 0; i + 9 < data.length; i++) {
    if (data[i] !== 126 || data[i + 9] !== 35) continue; // '~' ........ '#'
    let n = 0;
    let ok = true;
    for (let j = 1; j <= 8; j++) {
      const digit = data[i + j] - 48;
      if (digit < 0 || digit > 9) {
        ok = false;
        break;
      }
      n = n * 10 + digit;
    }
    if (ok) {
      cb(n);
      i += 9;
    }
  }
}

/**
 * A cheap load-test client. It sends real Yjs updates and completes the handshake like any client,
 * but it does not keep a replica of the document: live update frames are scanned for markers in
 * their raw bytes and discarded, and the initial state transfer is ignored. The server does exactly
 * the same work either way (accept, apply, persist, fan out), but the load generator stays cheap
 * enough that it is not the bottleneck (a full replica per virtual user saturated k6 at 1,000
 * editors, see bench/README.md).
 */
export function createLiteClient({ onSend, onMarker, clientId }) {
  const doc = new Y.Doc(); // holds only this client's own typing
  if (clientId) doc.clientID = clientId;
  const text = doc.getText('content');

  doc.on('update', (update) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    onSend(encoding.toUint8Array(enc));
  });

  return {
    step1() {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      return encoding.toUint8Array(enc);
    },
    handle(data) {
      if (data.length < 2 || data[0] !== MSG_SYNC) return;
      const sub = data[1];
      if (sub === syncProtocol.messageYjsSyncStep1) {
        // The server asks what we have: answer like a real client (our own typing only).
        const dec = decoding.createDecoder(data);
        decoding.readVarUint(dec);
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, reply, doc, doc);
        if (encoding.length(reply) > 1) onSend(encoding.toUint8Array(reply));
      } else if (sub === syncProtocol.messageYjsUpdate) {
        findMarkers(data, onMarker); // live edit from a peer
      }
      // sync step 2 = history replay: ignored (see createClient)
    },
    typeMarker(nowMs) {
      const ts8 = String(nowMs % 100_000_000).padStart(8, '0');
      text.insert(text.length, `~${ts8}# `);
    },
    length: () => text.length,
    destroy: () => doc.destroy(),
  };
}

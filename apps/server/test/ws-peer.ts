import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import * as Y from 'yjs';

export async function waitFor(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A minimal y-websocket-compatible client, used to drive the server in tests. */
export class Peer {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  ws!: WebSocket;
  synced = false;
  closeCode: number | null = null;
  /** Number of "comments changed" pings received (application message type 10). */
  commentPings = 0;

  static async connect(
    url: string,
    opts: { cookie?: string; origin?: string; waitSynced?: boolean } = {},
  ): Promise<Peer> {
    const peer = new Peer();
    peer.ws = new WebSocket(url, {
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
    });
    peer.ws.on('close', (code) => (peer.closeCode = code));
    peer.ws.on('error', () => undefined);
    peer.ws.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, peer.doc);
      peer.ws.send(encoding.toUint8Array(enc));
    });
    peer.ws.on('message', (data: Buffer) => peer.onMessage(new Uint8Array(data)));
    peer.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === peer) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update);
      peer.send(encoding.toUint8Array(enc));
    });
    peer.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin !== 'local') return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 1);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(peer.awareness, [
            ...added,
            ...updated,
            ...removed,
          ]),
        );
        peer.send(encoding.toUint8Array(enc));
      },
    );
    if (opts.waitSynced !== false) {
      await waitFor(() => peer.synced || peer.closeCode !== null, 5000, 'initial sync');
    }
    return peer;
  }

  get text(): Y.Text {
    return this.doc.getText('content');
  }

  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const sub = syncProtocol.readSyncMessage(decoder, enc, this.doc, this);
      if (sub === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
    } else if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    } else if (type === 10) {
      this.commentPings++;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.close();
        await waitFor(() => this.closeCode !== null, 5000, 'close');
      }
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'close');
    } finally {
      // Awareness runs a 3 s interval timer for its whole life; left alone it keeps the test
      // worker alive for ~10 s after the last test ("close timed out").
      this.awareness.destroy();
    }
  }
}

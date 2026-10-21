import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'denied';

const MSG_COMMENTS = 10;

export const wsBase = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

/** Stable, readable colour per user id so everyone sees the same cursor colour for a person. */
export function colorFor(id: string): { color: string; light: string } {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return { color: `hsl(${h} 70% 45%)`, light: `hsl(${h} 70% 45% / 0.25)` };
}

export interface Collab {
  ydoc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  destroy(): void;
}

/**
 * One Yjs document wired to (a) IndexedDB, so edits survive reloads and offline sessions, and
 * (b) the sync server. Offline edits simply accumulate in the local doc and merge on reconnect:
 * the sync handshake exchanges state vectors, so only missing updates flow in each direction.
 */
export function openCollab(
  docId: string,
  onStatus: (s: ConnStatus) => void,
  onCommentsChanged: () => void = () => undefined,
): Collab {
  const ydoc = new Y.Doc();
  const local = new IndexeddbPersistence(`inkwell:${docId}`, ydoc);
  const provider = new WebsocketProvider(wsBase, `docs/${docId}`, ydoc);

  // Application message 10 = "comments changed" (y-websocket itself reserves 0-3).
  provider.messageHandlers[MSG_COMMENTS] = () => onCommentsChanged();

  provider.on('status', ({ status }: { status: string }) => {
    // Pings sent while we were offline are gone, so catch up whenever the socket (re)connects.
    if (status === 'connected') onCommentsChanged();
    onStatus(
      status === 'connected' ? 'online' : status === 'connecting' ? 'connecting' : 'offline',
    );
  });
  provider.on('connection-close', (e: CloseEvent | null) => {
    // 44xx = auth/permission/not-found: retrying can't help, so stop the reconnect loop.
    if (e && e.code >= 4400 && e.code < 4500) {
      provider.disconnect();
      onStatus('denied');
    }
  });

  return {
    ydoc,
    text: ydoc.getText('content'),
    provider,
    destroy() {
      provider.destroy();
      void local.destroy();
      ydoc.destroy();
    },
  };
}

/** Encodes a text position as a base64 Yjs RelativePosition: it follows the text as others edit. */
export function encodeAnchor(text: Y.Text, index: number): string {
  const bytes = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Resolves an anchor to the current absolute index, or null if it cannot be resolved. */
export function resolveAnchor(ydoc: Y.Doc, b64: string): number | null {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes), ydoc);
    return abs ? abs.index : null;
  } catch {
    return null;
  }
}

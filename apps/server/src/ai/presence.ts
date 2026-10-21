import { randomInt } from 'node:crypto';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { Conn, Room } from '../sync/room.js';
import { fromB64 } from './anchors.js';

/** How the agent is shown to people editing the document. */
export const AI_USER = {
  id: 'ai-assistant',
  name: 'AI assistant',
  color: '#7c3aed',
  colorLight: '#7c3aed33',
} as const;

/** Presence entries expire after 30 s unless renewed, so a long run refreshes its own. */
const RENEW_MS = 10_000;

/**
 * The agent as a Yjs peer. While a run is in progress it publishes an awareness state under its own
 * client id, named "AI assistant", with a cursor over the range it is working on. Editors render it
 * exactly like another person's cursor, and the presence list shows it. The entry is owned by the
 * connection the agent joined with, so it disappears with that connection even if the run crashes.
 */
export class AgentPresence {
  private readonly doc = new Y.Doc();
  private readonly awareness: awarenessProtocol.Awareness;
  private cursor: { anchor: unknown; head: unknown } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(
    private readonly room: Room,
    private readonly conn: Conn,
  ) {
    // A client id of its own, distinct from every browser's and from other agent runs.
    this.doc.clientID = randomInt(1, 2 ** 31);
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
  }

  /** Shows the agent, with its cursor spanning the given anchors (or no cursor). */
  show(range?: { start: string; end: string }): void {
    if (this.done) return;
    this.cursor = range
      ? {
          anchor: Y.relativePositionToJSON(Y.decodeRelativePosition(fromB64(range.start))),
          head: Y.relativePositionToJSON(Y.decodeRelativePosition(fromB64(range.end))),
        }
      : null;
    this.publish();
    this.timer ??= setInterval(() => this.publish(), RENEW_MS);
    this.timer.unref();
  }

  /** Removes the agent from the presence list. */
  clear(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.awareness.setLocalState(null);
    awarenessProtocol.applyAwarenessUpdate(
      this.room.awareness,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      this.conn,
    );
    this.awareness.destroy();
    this.doc.destroy();
  }

  private publish(): void {
    if (this.done) return;
    this.awareness.setLocalState({
      user: { ...AI_USER },
      ...(this.cursor ? { cursor: this.cursor } : {}),
    });
    awarenessProtocol.applyAwarenessUpdate(
      this.room.awareness,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      this.conn,
    );
  }
}

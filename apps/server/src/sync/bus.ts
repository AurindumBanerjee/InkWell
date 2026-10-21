import { Redis } from 'ioredis';

/**
 * Cross-server message bus. Semantics are deliberately weak, matching Redis pub/sub:
 * at-most-once, no ordering guarantees across channels, and messages can be lost while a
 * connection is down. Rooms compensate by re-syncing with their peers on (re)join and on
 * `onReconnect` (see Room.resync).
 */
export interface Bus {
  publish(channel: string, data: Uint8Array): Promise<void>;
  /** Resolves once the subscription is active, so callers can order "subscribe, then load". */
  subscribe(channel: string, handler: (data: Uint8Array) => void): Promise<() => Promise<void>>;
  /** Registers a callback fired after the bus recovers from a connection loss. */
  onReconnect(cb: () => void): () => void;
  close(): Promise<void>;
}

/** Single-process bus: used for single-node deployments and for in-process cluster tests. */
export class InMemoryBus implements Bus {
  private subs = new Map<string, Set<(d: Uint8Array) => void>>();
  private reconnect = new Set<() => void>();
  /** Test hook: return true to drop a message (simulates pub/sub loss). */
  drop: ((channel: string, data: Uint8Array) => boolean) | null = null;

  async publish(channel: string, data: Uint8Array): Promise<void> {
    if (this.drop?.(channel, data)) return;
    const handlers = this.subs.get(channel);
    if (!handlers) return;
    // Deliver asynchronously, like a network hop; copy so receivers can't alias the sender's buffer.
    for (const h of [...handlers]) setImmediate(() => h(data.slice()));
  }

  async subscribe(channel: string, handler: (d: Uint8Array) => void): Promise<() => Promise<void>> {
    let set = this.subs.get(channel);
    if (!set) this.subs.set(channel, (set = new Set()));
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) this.subs.delete(channel);
    };
  }

  onReconnect(cb: () => void): () => void {
    this.reconnect.add(cb);
    return () => this.reconnect.delete(cb);
  }

  /** Test hook: how many handlers are subscribed to a channel. */
  listenerCount(channel: string): number {
    return this.subs.get(channel)?.size ?? 0;
  }

  /** Test hook: simulate Redis coming back after an outage. */
  simulateReconnect(): void {
    this.reconnect.forEach((cb) => cb());
  }

  async close(): Promise<void> {
    this.subs.clear();
    this.reconnect.clear();
  }
}

/** Redis pub/sub bus. Two connections: a connection in subscriber mode cannot publish. */
export class RedisBus implements Bus {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<(d: Uint8Array) => void>>();
  private reconnect = new Set<() => void>();
  private everReady = false;

  constructor(url: string, onError: (err: unknown) => void = () => undefined) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.pub.on('error', onError);
    this.sub.on('error', onError);
    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      const set = this.handlers.get(channel.toString());
      if (set) for (const h of set) h(new Uint8Array(message));
    });
    // ioredis re-subscribes automatically after reconnecting; anything published in the gap is lost,
    // so tell listeners to re-sync.
    this.sub.on('ready', () => {
      if (this.everReady) this.reconnect.forEach((cb) => cb());
      this.everReady = true;
    });
  }

  async publish(channel: string, data: Uint8Array): Promise<void> {
    await this.pub.publish(channel, Buffer.from(data));
  }

  async subscribe(channel: string, handler: (d: Uint8Array) => void): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      this.handlers.set(channel, (set = new Set()));
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  onReconnect(cb: () => void): () => void {
    this.reconnect.add(cb);
    return () => this.reconnect.delete(cb);
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}

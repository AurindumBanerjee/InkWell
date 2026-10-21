/** Events pushed to people watching a document's AI activity over /ws/ai. */
export type AiEvent =
  | { type: 'suggestion'; id: string; status: string }
  | {
      type: 'progress';
      id: string;
      step: number;
      kind: 'search' | 'read' | 'write';
      detail: string;
    }
  | { type: 'budget'; exhausted: boolean };

type Listener = (event: AiEvent) => void;

/**
 * Per-document fan-out for AI events. In-process on purpose: the AI version runs as a single node
 * (see docs/adr/0007-ai-feature-flag.md and docs/deploy.md). Running several nodes would route
 * these through the same bus the document sync uses.
 */
export class AiHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(docId: string, fn: Listener): () => void {
    let set = this.listeners.get(docId);
    if (!set) this.listeners.set(docId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(docId);
    };
  }

  publish(docId: string, event: AiEvent): void {
    for (const fn of this.listeners.get(docId) ?? []) fn(event);
  }

  /** Tells every watcher, whatever the document (used when the global budget is spent). */
  broadcast(event: AiEvent): void {
    for (const set of this.listeners.values()) for (const fn of set) fn(event);
  }

  count(docId: string): number {
    return this.listeners.get(docId)?.size ?? 0;
  }
}

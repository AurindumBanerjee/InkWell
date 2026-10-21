import type { Db } from '../db.js';
import { canEdit } from '../permissions.js';
import type { Conn, RoomManager } from '../sync/room.js';
import { createVersion } from '../versions.js';
import { AgentError, DEFAULT_EXPAND_LIMITS, runExpand } from './agent.js';
import { anchorRange, resolveRange, TEXT_KEY } from './anchors.js';
import type { AiSecrets, AiSettings } from './config.js';
import type { AiHub } from './hub.js';
import { computeHunks, type Hunk } from './hunks.js';
import { estimateTokens, LlmError, type LlmClient } from './llm.js';
import type { ConcurrencyGate, DailyBudget, RateLimiter } from './limits.js';
import { cleanRewriteOutput, modeById, type ModeConfig } from './modes.js';
import { AgentPresence } from './presence.js';
import {
  commitApply,
  insertWorking,
  markFailed,
  markPending,
  planApply,
  transition,
  type SuggestionRow,
} from './suggestions.js';
import {
  parseLimits,
  retryAfterSeconds,
  withHeaders,
  withNotice,
  type SharedUsage,
} from './usage.js';
import type { FetchedPage } from './web/safeFetch.js';
import type { SearchClient } from './web/search.js';

export interface Logger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface AiServiceDeps {
  db: Db;
  rooms: RoomManager;
  hub: AiHub;
  llm: LlmClient;
  search: SearchClient;
  fetchPage: (url: string) => Promise<FetchedPage>;
  secrets: AiSecrets;
  settings: AiSettings;
  modes: readonly ModeConfig[];
  rate: RateLimiter;
  gate: ConcurrencyGate;
  budget: DailyBudget;
  shared: SharedUsage;
  log: Logger;
  keepAutoVersions?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Person {
  id: string;
  email: string;
}

export interface StartRequest {
  documentId: string;
  documentTitle: string;
  mode: string;
  /** The selected range, as Yjs relative positions from the browser. Omitted = whole document. */
  anchorStart?: string;
  anchorEnd?: string;
  /** A user's own key, for this run only. Never stored, logged or returned. */
  apiKey?: string;
}

export type StartResult =
  | { ok: true; suggestion: SuggestionRow }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      retryAfterS?: number;
      resetsAt?: string;
    };

const fail = (
  status: number,
  code: string,
  message: string,
  extra: { retryAfterS?: number; resetsAt?: string } = {},
): StartResult => ({ ok: false, status, code, message, ...extra });

/** Error codes a run can end with, and what the user is told. Codes only: never provider text. */
export const ERROR_MESSAGES: Record<string, string> = {
  'no-changes': 'No changes suggested.',
  'too-many-changes': 'The model changed too much for a grammar fix. Try a smaller selection.',
  'length-changed': 'The model changed the length too much. Try a smaller selection.',
  'content-changed': 'The model changed the content instead of only the formatting.',
  'empty-output': 'The model returned nothing.',
  'bad-output': 'The model gave an answer in an unexpected format.',
  'no-claims': 'No sourced material could be found for this passage.',
  budget: 'This request used its token budget before finishing.',
  steps: 'The research ran out of steps before finishing.',
  'global-budget': "Today's shared AI budget has been used up.",
  'llm-auth': 'The AI provider rejected the key.',
  'llm-not-found': 'The AI provider does not offer the configured model to this key.',
  'llm-rate-limit': 'The AI provider is rate-limiting this key right now.',
  'llm-error': 'The AI provider returned an error.',
  'search-unavailable': 'Web search is not available.',
  timeout: 'The request took too long and was stopped.',
  cancelled: 'Cancelled.',
  interrupted: 'The server restarted while this was running.',
};

export class AiService {
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly d: AiServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Invite-only deployments list the emails allowed to use the AI at all. */
  isInvited(user: Person): boolean {
    const list = this.d.settings.allowedEmails;
    return list.length === 0 || list.includes(user.email.toLowerCase());
  }

  async start(user: Person, req: StartRequest): Promise<StartResult> {
    const { settings: cfg } = this.d;
    if (!this.isInvited(user))
      return fail(403, 'invite-only', 'The AI assistant is invite-only on this server.');

    const mode = modeById(req.mode, this.d.modes);
    if (!mode) return fail(400, 'unknown-mode', 'Unknown mode.');

    if (!req.apiKey && !this.d.llm.serverKeyConfigured) {
      return fail(
        503,
        'not-configured',
        'No model is configured. Add your own API key to use the AI.',
      );
    }
    if (mode.kind === 'research' && !this.d.search.configured) {
      return fail(503, 'search-not-configured', 'Web search is not configured on this server.');
    }
    // Requests with the user's own key spend that user's quota, so they are not stopped by the
    // shared budget; they are still rate limited below.
    if (!req.apiKey) {
      const b = await this.d.budget.status();
      if (b.exhausted) {
        return fail(503, 'budget-exhausted', "Today's shared AI budget has been used up.", {
          resetsAt: b.resetsAt,
        });
      }
    }
    const rate = this.d.rate.check(user.id);
    if (!rate.ok) {
      return fail(
        429,
        'rate-limited',
        `Too many AI requests (${rate.scope === 'minute' ? 'per minute' : 'per day'}).`,
        {
          retryAfterS: rate.retryAfterS,
        },
      );
    }
    const release = this.d.gate.tryAcquire(user.id);
    if (!release)
      return fail(429, 'busy', 'An AI request is already running. Wait for it to finish.');

    // Join the document as a peer: the room gives the live text and carries the agent's presence.
    const aiConn: Conn = { canEdit: false, send: () => undefined, close: () => undefined };
    let room;
    try {
      room = await this.d.rooms.join(req.documentId, aiConn);
    } catch {
      release();
      return fail(500, 'internal', 'Could not open the document.');
    }
    const leave = () => this.d.rooms.leave(room, aiConn);

    try {
      const text = room.doc.getText(TEXT_KEY);
      let from = 0;
      let to = text.length;
      if (req.anchorStart && req.anchorEnd) {
        const r = resolveRange(room.doc, req.anchorStart, req.anchorEnd);
        if (!r) {
          leave();
          release();
          return fail(400, 'bad-selection', 'The selection could not be found in the document.');
        }
        ({ from, to } = r);
      }
      const base = text.toString().slice(from, to);
      if (mode.kind === 'rewrite' && !base.trim()) {
        leave();
        release();
        return fail(400, 'empty-selection', 'Select some text first.');
      }
      if (base.length > cfg.maxInputChars) {
        leave();
        release();
        return fail(
          413,
          'too-long',
          `Select at most ${cfg.maxInputChars.toLocaleString('en-US')} characters.`,
        );
      }
      if (mode.kind === 'rewrite' && estimateTokens(base) * 2.3 + 400 > cfg.requestTokenBudget) {
        leave();
        release();
        return fail(
          413,
          'too-long',
          'That selection is too long for one request. Select less text.',
        );
      }

      const anchors = anchorRange(text, from, to);
      const row = await insertWorking(this.d.db, {
        documentId: req.documentId,
        userId: user.id,
        mode: mode.id,
        anchorStart: anchors.start,
        anchorEnd: anchors.end,
        baseText: base,
        ownKey: Boolean(req.apiKey),
      });
      this.d.rate.record(user.id);

      const presence = new AgentPresence(room, aiConn);
      presence.show(anchors);
      this.d.hub.publish(row.document_id, { type: 'suggestion', id: row.id, status: 'working' });

      // The run continues after this request returns; the browser follows it over /ws/ai.
      void this.run(row, mode, req, user, presence, leave, release);
      return { ok: true, suggestion: row };
    } catch (err) {
      this.d.log.error({ err: (err as Error).name }, 'ai start failed');
      leave();
      release();
      return fail(500, 'internal', 'Could not start the AI request.');
    }
  }

  private async run(
    row: SuggestionRow,
    mode: ModeConfig,
    req: StartRequest,
    user: Person,
    presence: AgentPresence,
    leave: () => void,
    release: () => void,
  ): Promise<void> {
    const { db, hub, settings: cfg } = this.d;
    const ac = new AbortController();
    this.active.set(row.id, ac);
    const timer = setTimeout(() => ac.abort(new Error('timeout')), cfg.runTimeoutMs);
    timer.unref();

    let tokens = 0;
    let steps = 0;
    let lastHeaders: Record<string, string> | undefined;
    let apiKey: string | undefined = req.apiKey; // held for this run only, cleared in `finally`
    const ownKey = Boolean(apiKey);

    const onUsage = async (
      used: number,
      headers: Record<string, string>,
    ): Promise<'ok' | 'exhausted'> => {
      tokens += used;
      steps++;
      lastHeaders = headers;
      // The shared key's limits are one record for everyone; own-key numbers go back to its owner only.
      if (!ownKey) this.d.shared.update((b) => withHeaders(b, headers, this.now()));
      if (ownKey) return 'ok';
      const exhausted = await this.d.budget.spend(used);
      if (exhausted) hub.broadcast({ type: 'budget', exhausted: true });
      return exhausted ? 'exhausted' : 'ok';
    };

    try {
      let proposed: string;
      let hunks: Hunk[];
      let sources: SuggestionRow['sources'] = null;

      if (mode.kind === 'rewrite') {
        const out = await this.rewrite(mode, row.base_text, apiKey, ac.signal, onUsage);
        proposed = out;
        hunks = computeHunks(row.base_text, proposed);
      } else {
        const outcome = await runExpand(
          {
            passage: row.base_text,
            title: req.documentTitle,
            baseText: row.base_text,
            apiKey,
            signal: ac.signal,
          },
          {
            llm: this.d.llm,
            search: this.d.search,
            fetchPage: this.d.fetchPage,
            sleep: this.d.sleep,
          },
          { maxSteps: cfg.maxSteps, maxTokens: cfg.expandTokenBudget, ...DEFAULT_EXPAND_LIMITS },
          {
            onUsage,
            onProgress: (e) => hub.publish(row.document_id, { type: 'progress', id: row.id, ...e }),
          },
        );
        proposed = row.base_text + outcome.insert;
        hunks = [
          { start: row.base_text.length, end: row.base_text.length, insert: outcome.insert },
        ];
        sources = outcome.sources;
      }

      const limits = lastHeaders ? { ...parseLimits(lastHeaders), takenAt: this.now() } : undefined;
      if (hunks.length === 0) {
        await markFailed(db, row.id, 'no-changes', { tokens, steps, limits });
      } else {
        await markPending(db, row.id, {
          proposedText: proposed,
          hunks,
          sources: sources ?? undefined,
          tokens,
          steps,
          limits,
        });
      }
    } catch (err) {
      const aborted = ac.signal.aborted;
      let code = 'llm-error';
      let retryAfterS: number | undefined;
      if (err instanceof AgentError) {
        code = err.code;
        retryAfterS = err.retryAfterS;
      } else if (err instanceof LlmError) {
        code =
          err.kind === 'auth'
            ? 'llm-auth'
            : err.kind === 'not-found'
              ? 'llm-not-found'
              : err.kind === 'rate-limit'
                ? 'llm-rate-limit'
                : 'llm-error';
        retryAfterS = retryAfterSeconds(err.headers);
        if (err.kind === 'rate-limit') {
          const book = withNotice({ lastProbeAt: 0 }, err.limit, retryAfterS, this.now());
          if (!ownKey)
            this.d.shared.update(() => ({ ...this.d.shared.snapshot(), notice: book.notice }));
        }
      } else if (err instanceof RewriteRejected) {
        code = err.reason;
      }
      if (aborted && code !== 'cancelled')
        code = ac.signal.reason?.message === 'timeout' ? 'timeout' : 'cancelled';
      // Log the code only: never the error object, which could carry request details.
      this.d.log.warn({ code, mode: mode.id }, 'ai run ended without a suggestion');
      const limits = lastHeaders
        ? {
            ...parseLimits(lastHeaders),
            takenAt: this.now(),
            ...(retryAfterS !== undefined ? { retryAfterS } : {}),
          }
        : retryAfterS !== undefined
          ? { retryAfterS, takenAt: this.now() }
          : undefined;
      await markFailed(db, row.id, code, {
        tokens,
        steps,
        limits,
        status: code === 'cancelled' ? 'cancelled' : 'failed',
      }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      this.active.delete(row.id);
      apiKey = undefined;
      presence.clear();
      leave();
      release();
      const done = await this.d.db
        .query<{ status: string }>('SELECT status FROM ai_suggestions WHERE id = $1', [row.id])
        .then((r) => r.rows[0]?.status ?? 'failed')
        .catch(() => 'failed');
      hub.publish(row.document_id, { type: 'suggestion', id: row.id, status: done });
      void user;
    }
  }

  private async rewrite(
    mode: ModeConfig,
    base: string,
    apiKey: string | undefined,
    signal: AbortSignal,
    onUsage: (n: number, h: Record<string, string>) => Promise<'ok' | 'exhausted'>,
  ): Promise<string> {
    const prompt = [
      { role: 'system' as const, content: mode.system ?? '' },
      { role: 'user' as const, content: `<document>\n${base}\n</document>` },
    ];
    const promptTokens = prompt.reduce((n, m) => n + estimateTokens(m.content), 0);
    const budget = this.d.settings.requestTokenBudget;
    // Room for the answer (about the size of the input) plus the model's own thinking.
    const maxTokens = Math.max(
      300,
      Math.min(budget - promptTokens, estimateTokens(base) * 2 + 1500),
    );
    const completion = await this.d.llm.complete({
      messages: prompt,
      maxTokens,
      temperature: mode.temperature,
      apiKey,
      signal,
    });
    if (
      (await onUsage(completion.usage.totalTokens || promptTokens, completion.headers)) ===
      'exhausted'
    ) {
      throw new AgentError('global-budget');
    }
    const output = cleanRewriteOutput(completion.text, base);
    const problem = mode.check?.(base, output);
    if (problem) throw new RewriteRejected(problem);
    return output;
  }

  cancel(id: string): boolean {
    const ac = this.active.get(id);
    ac?.abort(new Error('cancelled'));
    return Boolean(ac);
  }

  /** Marks pending suggestions that can no longer be applied as stale, without applying anything. */
  async refreshStale(documentId: string, rows: SuggestionRow[]): Promise<SuggestionRow[]> {
    const pending = rows.filter((r) => r.status === 'pending');
    if (pending.length === 0) return rows;
    const stale = await this.d.rooms.withRoom(documentId, (room) =>
      pending.filter((r) => !planApply(room.doc, r).ok).map((r) => r.id),
    );
    if (stale.length === 0) return rows;
    for (const id of stale) {
      await transition(this.d.db, id, ['pending'], 'stale');
      this.d.hub.publish(documentId, { type: 'suggestion', id, status: 'stale' });
    }
    return rows.map((r) => (stale.includes(r.id) ? { ...r, status: 'stale' as const } : r));
  }

  /**
   * Applies a suggestion if, and only if, it still applies cleanly to the document as it is now.
   * The change is ONE Yjs transaction, preceded by a safety version so it can be undone from history.
   */
  async accept(
    user: Person,
    role: Parameters<typeof canEdit>[0],
    row: SuggestionRow,
  ): Promise<
    | { ok: true; hunks: number }
    | { ok: false; status: number; code: string; message: string; reason?: string }
  > {
    if (!canEdit(role))
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'Only editors can accept suggestions.',
      };
    // Claim it first, so two people clicking Accept cannot apply it twice.
    const claimed = await transition(this.d.db, row.id, ['pending'], 'accepted', user.id);
    if (!claimed) {
      return {
        ok: false,
        status: 409,
        code: 'not-pending',
        message: `This suggestion is ${row.status}.`,
      };
    }
    const outcome = await this.d.rooms.withRoom(row.document_id, async (room, conn) => {
      const plan = planApply(room.doc, claimed);
      if (!plan.ok) return plan;
      await createVersion(
        this.d.db,
        row.document_id,
        {
          kind: 'auto',
          label: `Before AI suggestion (${claimed.mode})`,
          userId: user.id,
          doc: room.doc,
        },
        this.d.keepAutoVersions ?? 100,
      );
      commitApply(room.doc, plan, conn);
      await room.flush();
      return plan;
    });
    if (!outcome.ok) {
      await this.d.db.query(
        `UPDATE ai_suggestions SET status = 'stale', resolved_by = NULL, resolved_at = NULL WHERE id = $1`,
        [row.id],
      );
      this.d.hub.publish(row.document_id, { type: 'suggestion', id: row.id, status: 'stale' });
      return {
        ok: false,
        status: 409,
        code: 'stale',
        reason: outcome.reason,
        message: 'The text changed too much since this was suggested.',
      };
    }
    this.d.hub.publish(row.document_id, { type: 'suggestion', id: row.id, status: 'accepted' });
    return { ok: true, hunks: outcome.hunks.length };
  }

  async reject(user: Person, row: SuggestionRow): Promise<boolean> {
    const done = await transition(this.d.db, row.id, ['pending', 'stale'], 'rejected', user.id);
    if (done)
      this.d.hub.publish(row.document_id, { type: 'suggestion', id: row.id, status: 'rejected' });
    return Boolean(done);
  }
}

/** A rewrite the mode's own contract refused (for example a grammar fix that rewrote the text). */
class RewriteRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

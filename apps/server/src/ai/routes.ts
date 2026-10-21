import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { requireUser } from '../app.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { canEdit, canView } from '../permissions.js';
import { loadDocument } from '../routes/documents.js';
import type { AiSecrets, AiSettings } from './config.js';
import type { AiHub } from './hub.js';
import { checkKey, InvalidKeyFormat, keyFromHeaders } from './keys.js';
import type { LlmClient } from './llm.js';
import type { DailyBudget, RateLimiter } from './limits.js';
import type { ModeConfig } from './modes.js';
import { ERROR_MESSAGES, type AiService, type Person } from './service.js';
import { getSuggestion, listSuggestions, toPublic } from './suggestions.js';
import { emptyBook, usageView, withHeaders, type SharedUsage } from './usage.js';
import type { SearchClient } from './web/search.js';

const uuid = z.string().uuid();
const anchor = z.string().min(1).max(400);

const createBody = z
  .object({
    documentId: uuid,
    mode: z.string().min(1).max(40),
    anchorStart: anchor.optional(),
    anchorEnd: anchor.optional(),
  })
  .refine((b) => (b.anchorStart === undefined) === (b.anchorEnd === undefined), {
    message: 'anchorStart and anchorEnd must be given together',
  });

export interface AiRouteDeps {
  db: Db;
  service: AiService;
  hub: AiHub;
  secrets: AiSecrets;
  settings: AiSettings;
  llm: LlmClient;
  search: SearchClient;
  shared: SharedUsage;
  budget: DailyBudget;
  rate: RateLimiter;
  modes: readonly ModeConfig[];
  now: () => number;
}

/** Reads the user's own key from the request header. It lives in this request only. */
function ownKey(req: FastifyRequest): string | undefined {
  try {
    return keyFromHeaders(req.headers);
  } catch (err) {
    if (err instanceof InvalidKeyFormat) throw new HttpError(400, err.message);
    throw err;
  }
}

export async function registerAiRoutes(app: FastifyInstance, d: AiRouteDeps): Promise<void> {
  // AI responses hold per-user data and (for own-key runs) limits: never cache them anywhere.
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });

    const person = (req: FastifyRequest): Person => {
      const u = requireUser(req);
      return { id: u.id, email: u.email };
    };
    const invited = (req: FastifyRequest): Person => {
      const p = person(req);
      if (!d.service.isInvited(p))
        throw new HttpError(403, 'The AI assistant is invite-only on this server.');
      return p;
    };

    // ---- what the UI needs to know -------------------------------------------------------------
    scope.get('/ai/status', async (req) => {
      const user = person(req);
      const allowed = d.service.isInvited(user);
      const budget = await d.budget.status();
      return {
        enabled: true,
        invite: { restricted: d.settings.allowedEmails.length > 0, allowed },
        modes: d.modes.map(({ id, label, description, kind, placement }) => ({
          id,
          label,
          description,
          kind,
          placement,
        })),
        llm: { serverKeyConfigured: d.llm.serverKeyConfigured, model: d.secrets.model },
        // Kept for the first scaffold's clients: whether keys exist, never their values.
        llmConfigured: d.llm.serverKeyConfigured,
        searchConfigured: d.search.configured,
        search: { configured: d.search.configured, provider: d.secrets.searchProvider },
        limits: {
          perMinute: d.settings.ratePerMinute,
          perDay: d.settings.ratePerDay,
          remaining: d.rate.remaining(user.id),
          maxInputChars: d.settings.maxInputChars,
          requestTokenBudget: d.settings.requestTokenBudget,
          expandTokenBudget: d.settings.expandTokenBudget,
          maxSteps: d.settings.maxSteps,
        },
        budget,
        usage: usageView(false, d.shared.snapshot(), d.now()),
        features: d.modes.map((m) => m.id),
      };
    });

    // ---- bring your own key --------------------------------------------------------------------
    scope.post('/ai/key/check', async (req, reply) => {
      invited(req);
      const key = ownKey(req);
      if (!key) throw new HttpError(400, 'No key provided.');
      const result = await checkKey(d.llm, key, d.now());
      // The key is not part of the answer: the browser shows its own masked copy.
      return reply.send({
        accepted: result.accepted,
        message: result.message,
        usage: result.book ? usageView(true, result.book, d.now()) : null,
      });
    });

    scope.post('/ai/usage/refresh', async (req) => {
      invited(req);
      const key = ownKey(req);
      if (key) {
        try {
          const headers = await d.llm.probe(key);
          return { usage: usageView(true, withHeaders(emptyBook(), headers, d.now()), d.now()) };
        } catch {
          return {
            usage: usageView(true, emptyBook(), d.now()),
            note: 'Could not read usage with that key.',
          };
        }
      }
      if (!d.llm.serverKeyConfigured) {
        return {
          usage: usageView(false, emptyBook(), d.now()),
          note: 'No shared key is configured.',
        };
      }
      if (!d.shared.claimRefresh()) {
        return {
          usage: usageView(false, d.shared.snapshot(), d.now()),
          note: 'Showing the latest reading: the shared key is refreshed at most every 30 s.',
        };
      }
      try {
        const headers = await d.llm.probe();
        d.shared.update((b) => withHeaders(b, headers, d.now()));
      } catch {
        return {
          usage: usageView(false, d.shared.snapshot(), d.now()),
          note: 'Could not read usage right now.',
        };
      }
      return { usage: usageView(false, d.shared.snapshot(), d.now()) };
    });

    // ---- suggestions ---------------------------------------------------------------------------
    scope.post('/ai/suggestions', async (req, reply) => {
      const user = invited(req);
      const body = createBody.parse(req.body);
      const { doc, role } = await loadDocument(d.db, body.documentId, user.id);
      // Enforced here, on the server, whatever the UI shows: viewers cannot invoke the agent.
      if (!canEdit(role)) throw new HttpError(403, 'Only editors can use the AI assistant.');

      const result = await d.service.start(user, {
        documentId: doc.id,
        documentTitle: doc.title,
        mode: body.mode,
        anchorStart: body.anchorStart,
        anchorEnd: body.anchorEnd,
        apiKey: ownKey(req),
      });
      if (!result.ok) {
        if (result.retryAfterS !== undefined)
          reply.header('retry-after', String(result.retryAfterS));
        return reply.code(result.status).send({
          error: result.code,
          message: result.message,
          retryAfterS: result.retryAfterS,
          resetsAt: result.resetsAt,
        });
      }
      return reply.code(202).send({ suggestion: toPublic(result.suggestion, user.id) });
    });

    scope.get('/ai/suggestions', async (req) => {
      const user = invited(req);
      const { documentId } = z.object({ documentId: uuid }).parse(req.query);
      const { role } = await loadDocument(d.db, documentId, user.id);
      if (!canView(role)) throw new HttpError(404, 'document not found');
      const rows = await d.service.refreshStale(
        documentId,
        await listSuggestions(d.db, documentId),
      );
      return {
        canEdit: canEdit(role),
        suggestions: rows.map((r) => toPublic(r, user.id)),
        messages: ERROR_MESSAGES,
      };
    });

    const load = async (req: FastifyRequest) => {
      const user = invited(req);
      const id = uuid.parse((req.params as { id: string }).id);
      const row = await getSuggestion(d.db, id);
      if (!row) throw new HttpError(404, 'suggestion not found');
      const { role } = await loadDocument(d.db, row.document_id, user.id); // 404s if no access
      return { user, row, role };
    };

    scope.get('/ai/suggestions/:id', async (req) => {
      const { user, row } = await load(req);
      return { suggestion: toPublic(row, user.id) };
    });

    scope.post('/ai/suggestions/:id/accept', async (req, reply) => {
      const { user, row, role } = await load(req);
      const result = await d.service.accept(user, role, row);
      if (!result.ok) {
        return reply
          .code(result.status)
          .send({ error: result.code, message: result.message, reason: result.reason });
      }
      return { ok: true, hunks: result.hunks };
    });

    scope.post('/ai/suggestions/:id/reject', async (req) => {
      const { user, row, role } = await load(req);
      if (!canEdit(role)) throw new HttpError(403, 'Only editors can reject suggestions.');
      return { ok: await d.service.reject(user, row) };
    });

    scope.post('/ai/suggestions/:id/cancel', async (req) => {
      const { user, row, role } = await load(req);
      if (!canEdit(role)) throw new HttpError(403, 'Only editors can cancel a request.');
      if (row.created_by !== user.id && role !== 'owner')
        throw new HttpError(403, 'Not your request.');
      return { ok: d.service.cancel(row.id) };
    });

    // ---- live events over WebSocket ------------------------------------------------------------
    // Separate from document sync (/ws/docs/:id) so the sync protocol is untouched by the flag.
    scope.get('/ws/ai', { websocket: true }, (socket: WebSocket, req) => {
      void (async () => {
        if (!req.user) return socket.close(4401, 'authentication required');
        const q = (req.query as { doc?: string }).doc;
        let off = () => undefined as void;
        if (q !== undefined) {
          const parsed = uuid.safeParse(q);
          if (!parsed.success) return socket.close(4404, 'document not found');
          try {
            await loadDocument(d.db, parsed.data, req.user.id);
          } catch {
            return socket.close(4404, 'document not found');
          }
          off = d.hub.subscribe(parsed.data, (e) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
          });
        } else {
          off = d.hub.subscribe('*', (e) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
          });
        }
        if (socket.readyState !== socket.OPEN) return off(); // closed while we were checking access
        socket.on('close', () => off());
        socket.send(JSON.stringify({ type: 'ready', features: d.modes.map((m) => m.id) }));
      })();
    });
  });
}

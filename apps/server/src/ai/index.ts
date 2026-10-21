import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { requireUser } from '../app.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { RoomManager } from '../sync/room.js';
import { loadAiSecrets, type AiSecrets } from './config.js';

export interface AiDeps {
  config: Config;
  db: Db;
  rooms: RoomManager;
  /** Where provider keys are read from (process.env unless a test injects one). */
  env: NodeJS.ProcessEnv;
}

/**
 * Everything that makes this the "AI version" of Inkwell registers here, and only here. app.ts
 * imports this module dynamically and only when AI_FEATURES is on, so the normal build never
 * loads it, never registers its routes (they 404) and never reads an LLM or search key.
 *
 * The AI collaborator (modes, suggestions, web tool, budgets, rate limits) builds on this seam.
 */
export async function registerAi(app: FastifyInstance, deps: AiDeps): Promise<AiSecrets> {
  const secrets = loadAiSecrets(deps.env);

  // What the UI needs to know. Reports whether keys exist, never their values.
  app.get('/ai/status', async (req) => {
    requireUser(req);
    return {
      enabled: true,
      llmConfigured: secrets.llmConfigured,
      searchConfigured: secrets.searchConfigured,
      features: [] as string[],
    };
  });

  // The AI channel is its own WebSocket route, separate from document sync (/ws/docs/:id), so the
  // sync protocol and its tests are untouched by the flag.
  app.get('/ws/ai', { websocket: true }, (socket: WebSocket, req) => {
    if (!req.user) return socket.close(4401, 'authentication required');
    socket.send(JSON.stringify({ type: 'ready', features: [] }));
  });

  return secrets;
}

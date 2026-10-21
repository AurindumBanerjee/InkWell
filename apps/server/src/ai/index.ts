import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { MIGRATIONS_DIR, migrate } from '../migrate.js';
import type { RoomManager } from '../sync/room.js';
import { loadAiSecrets, loadAiSettings, type AiSecrets } from './config.js';
import { AiHub } from './hub.js';
import { ConcurrencyGate, DailyBudget, RateLimiter } from './limits.js';
import { OpenAiCompatClient, type LlmClient } from './llm.js';
import { MODES, type ModeConfig } from './modes.js';
import { registerAiRoutes } from './routes.js';
import { AiService } from './service.js';
import { sweepInterrupted } from './suggestions.js';
import { SharedUsage } from './usage.js';
import { fetchPage as safeFetchPage, type FetchedPage } from './web/safeFetch.js';
import { TavilyClient, type SearchClient } from './web/search.js';

/** Replaceable parts, so tests (and the e2e stack) can run the whole feature without a network. */
export interface AiOverrides {
  llm?: LlmClient;
  search?: SearchClient;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  modes?: ModeConfig[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AiDeps {
  config: Config;
  db: Db;
  rooms: RoomManager;
  /** Where provider keys and settings are read from (process.env unless a test injects one). */
  env: NodeJS.ProcessEnv;
  overrides?: AiOverrides;
}

export interface AiHandle {
  secrets: AiSecrets;
  service: AiService;
}

/**
 * Everything that makes this the "AI version" of Inkwell registers here, and only here. app.ts
 * imports this module dynamically and only when AI_FEATURES is on, so the normal build never
 * loads it, never registers its routes (they 404) and never reads an LLM or search key.
 */
export async function registerAi(app: FastifyInstance, deps: AiDeps): Promise<AiHandle> {
  const o = deps.overrides ?? {};
  const now = o.now ?? Date.now;

  // The AI tables exist only in databases that run the AI version.
  await migrate(deps.db, path.join(MIGRATIONS_DIR, 'ai'), 'ai/');
  await sweepInterrupted(deps.db);

  const secrets = loadAiSecrets(deps.env);
  const settings = loadAiSettings(deps.env);
  const llm =
    o.llm ??
    new OpenAiCompatClient({
      baseUrl: secrets.baseUrl,
      model: secrets.model,
      apiKey: secrets.llmKey(),
      temperature: secrets.temperature,
    });
  const search = o.search ?? new TavilyClient({ apiKey: secrets.searchKey() });
  const hub = new AiHub();
  const shared = new SharedUsage(now);
  const budget = new DailyBudget(deps.db, settings.dailyTokenBudget, now);
  const rate = new RateLimiter({
    perMinute: settings.ratePerMinute,
    perDay: settings.ratePerDay,
    now,
  });
  const gate = new ConcurrencyGate(settings.maxConcurrentPerUser, settings.maxConcurrentTotal);
  const modes = o.modes ?? MODES;

  const service = new AiService({
    db: deps.db,
    rooms: deps.rooms,
    hub,
    llm,
    search,
    fetchPage: o.fetchPage ?? ((url) => safeFetchPage(url)),
    secrets,
    settings,
    modes,
    rate,
    gate,
    budget,
    shared,
    log: {
      // Codes and names only: request bodies, headers and error objects never go to the log.
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
    now,
    sleep: o.sleep,
  });

  await registerAiRoutes(app, {
    db: deps.db,
    service,
    hub,
    secrets,
    settings,
    llm,
    search,
    shared,
    budget,
    rate,
    modes,
    now,
  });
  return { secrets, service };
}

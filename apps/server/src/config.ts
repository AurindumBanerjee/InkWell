import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  /** Set to run several sync nodes; unset = single node with an in-process bus. */
  REDIS_URL: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  ENABLE_DEV_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * The AI-collaborator build of the app. Off by default. When off, the AI module is never loaded,
   * its routes and WebSocket handlers are not registered (they 404), and no LLM or search key is
   * read from the environment (see src/ai/ and docs/adr/0007-ai-feature-flag.md).
   */
  AI_FEATURES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production' && config.ENABLE_DEV_LOGIN) {
    throw new Error('ENABLE_DEV_LOGIN must not be enabled in production');
  }
  return config;
}

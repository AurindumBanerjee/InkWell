import path from 'node:path';
import { defineConfig } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npx tsx e2e/stack.ts',
      cwd: root,
      url: 'http://127.0.0.1:4100/healthz',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'npx next dev -p 3100',
      cwd: path.join(root, 'apps/web'),
      url: 'http://127.0.0.1:3100',
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        API_URL: 'http://127.0.0.1:4100',
        NEXT_PUBLIC_WS_URL: 'ws://localhost:4100/ws',
        NEXT_PUBLIC_DEV_LOGIN: 'true',
        NEXT_PUBLIC_E2E: 'true',
      },
    },
  ],
});

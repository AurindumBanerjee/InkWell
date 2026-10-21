import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4000';

// The production image sets NEXT_OUTPUT=standalone: a self-contained server in .next/standalone.
// The workspace root is traced so packages hoisted to the monorepo root are included.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

/** @type {import('next').NextConfig} */
export default {
  // E2E runs use their own build dir so they never collide with a developer's running `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  ...(standalone
    ? { output: 'standalone', outputFileTracingRoot: path.join(import.meta.dirname, '../..') }
    : {}),
  // Same-origin proxy so the session cookie and Origin check work without CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/:path*` }];
  },
};

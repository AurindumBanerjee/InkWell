const API = process.env.API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  // E2E runs use their own build dir so they never collide with a developer's running `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Same-origin proxy so the session cookie and Origin check work without CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/:path*` }];
  },
};

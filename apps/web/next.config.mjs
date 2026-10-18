const API = process.env.API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  // Same-origin proxy so the session cookie and Origin check work without CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/:path*` }];
  },
};

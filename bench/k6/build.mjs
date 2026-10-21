// Bundles the Yjs protocol client into a single ES module k6 can import.
//   node bench/k6/build.mjs
import { build } from 'esbuild';
import path from 'node:path';

const dir = import.meta.dirname;
await build({
  entryPoints: [path.join(dir, 'protocol.mjs')],
  outfile: path.join(dir, 'dist/protocol.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  logLevel: 'info',
});

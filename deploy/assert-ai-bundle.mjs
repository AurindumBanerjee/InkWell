// Asserts what a web build contains.
//   node deploy/assert-ai-bundle.mjs off [dir]   normal build: NO AI code anywhere in the output
//   node deploy/assert-ai-bundle.mjs on  [dir]   AI build: the AI collaborator UI is present
// `dir` defaults to apps/web/.next. The marker is a data-testid that exists only in the AI UI.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MARKER = 'inkwell-ai-collaborator-ui';
const [mode, dir = 'apps/web/.next'] = process.argv.slice(2);

if (mode !== 'on' && mode !== 'off') {
  console.error('usage: node deploy/assert-ai-bundle.mjs <on|off> [build dir]');
  process.exit(2);
}

/** @returns {string[]} files under `root` that contain the marker (JS, HTML, JSON, maps) */
export function filesContaining(root, marker = MARKER) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'cache') continue; // build caches can hold stale output from earlier builds
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (
        /\.(js|mjs|html|json|map|rsc|txt)$/.test(name) &&
        readFileSync(p, 'utf8').includes(marker)
      ) {
        hits.push(p);
      }
    }
  };
  walk(root);
  return hits;
}

if (
  import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replaceAll('\\', '/')}`).href
) {
  const hits = filesContaining(dir);
  if (mode === 'off' && hits.length > 0) {
    console.error(`FAIL: AI code found in a normal build (${hits.length} files), e.g. ${hits[0]}`);
    process.exit(1);
  }
  if (mode === 'on' && hits.length === 0) {
    console.error('FAIL: the AI build does not contain the AI collaborator UI');
    process.exit(1);
  }
  console.log(
    `ok: ${mode === 'off' ? 'no AI code in the build' : `AI UI present in ${hits.length} files`} (${dir})`,
  );
}

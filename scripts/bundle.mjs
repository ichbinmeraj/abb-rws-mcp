#!/usr/bin/env node
// Bundles src/cli.ts and every module it imports into one file, dist/cli.js,
// so the published package has no runtime dependencies: `npx abb-rws-mcp`
// resolves nothing from the registry beyond this package. The build's
// metafile goes to build/meta.json; scripts/notices.mjs checks that
// THIRD_PARTY_NOTICES.md names every package in it.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = JSON.parse(readFileSync(join(root, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'));

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
  define: { __SDK_VERSION__: JSON.stringify(sdk.version) },
  // Some bundled packages are CommonJS and call require() for Node built-ins.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __abbRwsMcpCreateRequire } from 'node:module';\nconst require = __abbRwsMcpCreateRequire(import.meta.url);" },
});

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build/meta.json'), JSON.stringify(result.metafile, null, 2));
try { chmodSync(join(root, 'dist/cli.js'), 0o755); } catch { /* not on every file system */ }

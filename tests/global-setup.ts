import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Bundle dist/cli.js before the tests: the protocol tests start it over stdio. */
export default function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url))], { stdio: 'inherit' });
}

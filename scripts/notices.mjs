#!/usr/bin/env node
// THIRD_PARTY_NOTICES.md lists every package bundled into dist/cli.js, with its
// version, its licence and the full text of its licence file. The list comes
// from the bundle's metafile (build/meta.json, written by scripts/bundle.mjs).
//
//   node scripts/notices.mjs          write THIRD_PARTY_NOTICES.md
//   node scripts/notices.mjs --check  fail when the file is not what the bundle needs
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const metaPath = join(root, 'build/meta.json');
const outPath = join(root, 'THIRD_PARTY_NOTICES.md');

/** The bundled packages, from the metafile's inputs: [{ name, version, license, text }], sorted by name. */
export function bundledPackages() {
  if (!existsSync(metaPath)) { throw new Error('build/meta.json is missing: run `node scripts/bundle.mjs` first'); }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const dirs = new Map();
  for (const input of Object.keys(meta.inputs)) {
    const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input.replace(/\\/g, '/'));
    if (m) { dirs.set(m[1], m[2]); }
  }
  const out = [];
  for (const [dir, name] of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const file = readdirSync(join(root, dir)).find(f => /^licen[cs]e(\.md|\.txt)?$/i.test(f));
    if (!file) { throw new Error(`${name} has no licence file`); }
    const text = readFileSync(join(root, dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    out.push({ name, version: pkg.version, license: pkg.license, text });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function render(packages) {
  const lines = [
    '# Third-party notices',
    '',
    'The published abb-rws-mcp package is one bundled file, `dist/cli.js`. It contains code from the',
    'packages below, each under its own licence, reproduced here as the licence asks. abb-rws-mcp',
    'itself is licensed under Apache-2.0 (see LICENSE and NOTICE).',
    '',
    '| Package | Version | Licence |',
    '|---|---|---|',
    ...packages.map(p => `| ${p.name} | ${p.version} | ${p.license} |`),
    '',
  ];
  for (const p of packages) {
    lines.push(`## ${p.name}@${p.version}`, '', `Licence: ${p.license}`, '', '```text', p.text, '```', '');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (isMain) {
  const text = render(bundledPackages());
  if (process.argv.includes('--check')) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) {
      process.stderr.write('THIRD_PARTY_NOTICES.md does not match the bundle: run `node scripts/notices.mjs` and commit it\n');
      process.exit(1);
    }
    process.stdout.write('THIRD_PARTY_NOTICES.md names every bundled package\n');
  } else {
    writeFileSync(outPath, text);
    process.stdout.write('THIRD_PARTY_NOTICES.md written\n');
  }
}

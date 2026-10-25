import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without types.
import { bundledPackages, render } from '../scripts/notices.mjs';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('the package', () => {
  it('THIRD_PARTY_NOTICES.md names every package the bundle contains, with its licence text', () => {
    const packages = bundledPackages() as { name: string; version: string }[];
    expect(packages.map(p => p.name)).toContain('@modelcontextprotocol/sdk');
    expect(packages.map(p => p.name)).toContain('zod');
    const notices = read('THIRD_PARTY_NOTICES.md');
    for (const p of packages) { expect(notices).toContain(`## ${p.name}@${p.version}`); }
    expect(notices).toBe(render(packages));
  });

  it('has no runtime dependencies, exact dev pins, and ships only the bundle and the documents', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies).toBeUndefined();
    for (const [name, v] of Object.entries(pkg.devDependencies as Record<string, string>)) {
      expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.bin).toEqual({ 'abb-rws-mcp': 'dist/cli.js' });
    expect(pkg.files).toEqual(['dist/cli.js', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md', 'README.md', 'CHANGELOG.md']);
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.type).toBe('module');
  });

  it('server.json for the MCP Registry names this package at its version, under package.json\'s mcpName', () => {
    const pkg = JSON.parse(read('package.json'));
    const server = JSON.parse(read('server.json'));
    expect(pkg.mcpName).toBe('io.github.ichbinmeraj/abb-rws-mcp');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } }]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('the bundle starts with a node shebang', () => {
    expect(read('dist/cli.js').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('the published bundle, SDK code included, has no process, file-write, socket-server or fetch call', () => {
    const bundle = read('dist/cli.js');
    for (const s of ['child_process', 'fetch(', 'node:net', 'node:https', 'node:dgram', 'WebSocket', 'writeFile', 'appendFile',
      'createWriteStream', '.listen(', 'worker_threads']) {
      expect(bundle.includes(s), s).toBe(false);
    }
  });
});

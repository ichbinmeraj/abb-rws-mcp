import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The read-only promise, checked on the source: nothing writes, spawns or opens
// a socket but the one client of the daemon, and no route outside the read
// table is even spelled out.
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}
const sources = files(SRC).map(f => ({ file: relative(SRC, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

describe('read-only, by the source', () => {
  it('no file writing, no child process, no other socket, no fetch', () => {
    // Call forms, word-bounded; for exec, spawn, rm and fetch the bare call only:
    // a method such as RegExp's .exec( starts no process.
    const forbidden = [
      /\bwriteFile(Sync)?\s*\(/, /\bappendFile(Sync)?\s*\(/, /\bcreateWriteStream\s*\(/, /\bmkdir(Sync)?\s*\(/, /\brmSync\s*\(/, /\brmdir(Sync)?\s*\(/,
      /\bunlink(Sync)?\s*\(/, /(?<![.\w$])rm\s*\(/, /child_process/, /(?<![.\w$])spawn\s*\(/, /(?<![.\w$])exec\s*\(/, /\bexecSync\s*\(/, /\bexecFile(Sync)?\s*\(/,
      /node:net\b/, /node:https\b/, /\bundici\b/, /\bWebSocket\b/, /(?<![.\w$])fetch\s*\(/, /\bsetInterval\s*\(/, /\bcopyFile/, /\brename(Sync)?\s*\(/,
      /\bchmod/, /\bsymlink/, /\btruncate\s*\(/, /node:dgram/, /node:worker_threads/, /\bsendLoggingMessage\b/,
    ];
    for (const { file, text } of sources) {
      for (const re of forbidden) { expect(re.test(text), `${file}: ${re}`).toBe(false); }
    }
  });

  it('node:http only in daemon.ts, node:fs only in token.ts (and config.ts reads no file)', () => {
    for (const { file, text } of sources) {
      if (/['"]node:http['"]/.test(text)) { expect(file).toBe('daemon.ts'); }
      if (/['"]node:fs(\/promises)?['"]/.test(text)) { expect(file).toBe('token.ts'); }
      if (/\bhttp\.request\s*\(/.test(text)) { expect(file).toBe('daemon.ts'); }
    }
    const token = sources.find(s => s.file === 'token.ts')!.text;
    expect(token).toMatch(/import \{ open \} from 'node:fs\/promises'/);
    expect(token).not.toMatch(/\bwrite\s*\(/);
  });

  it('no route outside the read table is spelled out; POST only for the motion lease', () => {
    for (const { file, text } of sources) {
      for (const route of ['/v0/admin', '/v0/setup', '/v0/recording', '/v0/replay', '/io/watch', '/v0/stream']) {
        expect(text.includes(route), `${file}: ${route}`).toBe(false);
      }
      if (/'POST'/.test(text)) { expect(file).toBe('daemon.ts'); }
      for (const m of ["'PUT'", "'DELETE'", "'PATCH'"]) { expect(text.includes(m), `${file}: ${m}`).toBe(false); }
    }
  });

  it('explain_event, read_rapid_variable and list_controllers never read the access group, a lock, a holder or a capability entry', () => {
    // As the daemon's own source scan: the property reads, in any spelling, with comments left out.
    const forbidden = [
      /\.access\b/, /\[\s*['"`]access['"`]\s*\]/, /\{[^}]*\baccess\b[^}]*\}\s*=/, /\.locks\b/, /\.holder\b/, /\.rmmp\b/,
      /\.remoteAccessEnabled\b/, /capabilities\s*\.\s*entries\b/, /\.entries\b/,
    ];
    for (const file of ['tools/explainEvent.ts', 'tools/rapidVariable.ts', 'tools/listControllers.ts']) {
      const source = sources.find(s => s.file === file);
      expect(source, file).toBeDefined();
      const code = source!.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const re of forbidden) { expect(re.test(code), `${file}: ${re}`).toBe(false); }
    }
  });

  it('the token goes only into its header, inside daemon.ts', () => {
    for (const { file, text } of sources) {
      if (/TOKEN_HEADER\]|x-abb-rws-token/.test(text)) { expect(file).toBe('daemon.ts'); }
    }
  });
});

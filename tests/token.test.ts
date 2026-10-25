import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TokenFileError, readTokenFile } from '../src/token.js';
import { tempDir } from './helpers.js';

const dir = tempDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const reason = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'read'; } catch (e) { return e instanceof TokenFileError ? e.reason : 'other'; }
};

describe('the token file', () => {
  it('reads and trims a valid token', async () => {
    const f = join(dir, 'ok');
    writeFileSync(f, '  abcdefghijklmnopqrstuvwxyz0123456789_-  \r\n');
    expect(await readTokenFile(f)).toBe('abcdefghijklmnopqrstuvwxyz0123456789_-');
  });

  it('missing, a folder, over 1 KiB or the wrong content: TOKEN_UNREADABLE reasons, without blocking', async () => {
    expect(await reason(readTokenFile(join(dir, 'none')))).toBe('missing');
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    expect(['not-a-file', 'unreadable']).toContain(await reason(readTokenFile(folder)));
    const big = join(dir, 'big');
    writeFileSync(big, 'a'.repeat(2000));
    expect(await reason(readTokenFile(big))).toBe('too-large');
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'short');
    expect(await reason(readTokenFile(bad))).toBe('bad-content');
    const spaced = join(dir, 'spaced');
    writeFileSync(spaced, 'abcdefghijklmnopqrstuvwxyz 0123456789');
    expect(await reason(readTokenFile(spaced))).toBe('bad-content');
  });

  it.skipIf(process.platform === 'win32')('a FIFO is refused at once, not read', async () => {
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    expect(await reason(readTokenFile(fifo))).toBe('not-a-file');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

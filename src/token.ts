import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Reading the daemon's token file, and the person's mark-codes file. This is
 * the only module that touches the file system, and it only reads: this server
 * never creates, copies or changes a file.
 */

/** What a token looks like (the daemon's TOKEN_PATTERN). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/** The largest token file read. */
export const TOKEN_FILE_MAX = 1024;

/** The largest mark-codes file read. */
export const LIST_FILE_MAX = 256 * 1024;

/** How long a read may take. */
export const TOKEN_READ_DEADLINE_MS = 2_000;

/** Why the token file could not be used. The reason is a fixed word; the path never goes into it. */
export class TokenFileError extends Error {
  constructor(readonly reason: 'missing' | 'not-a-file' | 'too-large' | 'unreadable' | 'timeout' | 'bad-content') {
    super(`token file ${reason}`);
    this.name = 'TokenFileError';
  }
}

/**
 * Read the token from `path`: opened without blocking where the platform
 * allows it, checked on the open handle (a regular file of at most 1 KiB, so a
 * FIFO or a device cannot block the read), read with a 2 s deadline, trimmed
 * and checked against TOKEN_PATTERN.
 */
export async function readTokenFile(path: string, deadlineMs = TOKEN_READ_DEADLINE_MS): Promise<string> {
  const token = (await withDeadline(readBounded(path, TOKEN_FILE_MAX), deadlineMs)).trim();
  if (!TOKEN_PATTERN.test(token)) { throw new TokenFileError('bad-content'); }
  return token;
}

/** A mark-codes file's text, read the same way (at most 256 KiB, 2 s). Its content is checked by the caller. */
export async function readListFile(path: string, deadlineMs = TOKEN_READ_DEADLINE_MS): Promise<string> {
  return withDeadline(readBounded(path, LIST_FILE_MAX), deadlineMs);
}

async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TokenFileError('timeout')), deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(path: string, max: number): Promise<string> {
  const flags = constants.O_RDONLY | (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') { throw new TokenFileError('missing'); }
    if (code === 'EISDIR') { throw new TokenFileError('not-a-file'); }
    throw new TokenFileError('unreadable');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) { throw new TokenFileError('not-a-file'); }
    if (st.size > max) { throw new TokenFileError('too-large'); }
    const buf = Buffer.alloc(max + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
      if (bytesRead === 0) { break; }
      read += bytesRead;
      if (read > max) { throw new TokenFileError('too-large'); }
    }
    return buf.subarray(0, read).toString('utf8');
  } catch (e) {
    if (e instanceof TokenFileError) { throw e; }
    throw new TokenFileError('unreadable');
  } finally {
    await handle.close().catch(() => {});
  }
}

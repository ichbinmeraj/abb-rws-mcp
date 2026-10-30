import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../src/config.js';
import { Context } from '../src/context.js';
import { DaemonClient, isAllowedRequest } from '../src/daemon.js';
import { ReadLimiter } from '../src/limits.js';
import { createLogger, type LogLevel } from '../src/log.js';
import { createServer } from '../src/server.js';
import { FakeDaemon } from './fakeDaemon.js';

export interface Harness {
  fake: FakeDaemon;
  ctx: Context;
  daemon: DaemonClient;
  client: Client;
  logLines: string[];
  dir: string;
  tokenFile: string;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  fake?: FakeDaemon;
  allowReplay?: boolean;
  motionSampling?: boolean;
  logLevel?: LogLevel;
  token?: string | null;
  requestDeadlineMs?: number;
  healthDeadlineMs?: number;
  now?: () => number;
  markCodes?: ReadonlySet<number> | null;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'abb-rws-mcp-test-'));
}

export async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const fake = o.fake ?? await new FakeDaemon().start();
  const dir = tempDir();
  const tokenFile = join(dir, 'token');
  if (o.token !== null) { writeFileSync(tokenFile, `${o.token ?? fake.token}\n`); }
  const logLines: string[] = [];
  const log = createLogger(o.logLevel ?? 'debug', line => { logLines.push(line); });
  const config: Config = {
    port: fake.port, hostHeader: `127.0.0.1:${fake.port}`, tokenFile,
    allowReplay: o.allowReplay ?? false, motionSampling: o.motionSampling ?? true, logLevel: o.logLevel ?? 'debug',
    markCodes: o.markCodes ?? null,
  };
  const daemon = new DaemonClient({
    port: fake.port, hostHeader: config.hostHeader, tokenFile, log,
    requestDeadlineMs: o.requestDeadlineMs, healthDeadlineMs: o.healthDeadlineMs, now: o.now,
  });
  const ctx = new Context(config, daemon, log, o.now);
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools();
  return {
    fake, ctx, daemon, client, logLines, dir, tokenFile,
    call: async (name, args = {}) => await client.callTool({ name, arguments: args }) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
      daemon.close();
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Forget this server's own read limits (tests that read many modules in a row). */
export function resetLimits(h: Harness): void {
  (h.ctx as unknown as { limiter: ReadLimiter }).limiter = new ReadLimiter();
}

export function text(r: CallToolResult): string {
  return r.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');
}

export function structured(r: CallToolResult): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Every request the fake received is one of the read-only table's. */
export function allAllowed(fake: FakeDaemon): boolean {
  return fake.log.every(r => isAllowedRequest(r.method, r.url, r.body));
}

/** The text between a block's markers, and the text outside every block. */
export function splitBlocks(t: string): { inside: string; outside: string } {
  const re = /--- controller data ([0-9a-f]{8}) ---\n([\s\S]*?)\n--- end of controller data \1 ---/g;
  let inside = '';
  const outside = t.replace(re, (_m, _n, body: string) => { inside += `${body}\n`; return ''; });
  return { inside, outside };
}

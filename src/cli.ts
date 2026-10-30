import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, USAGE, parseArgs, parseCodeList, type Config } from './config.js';
import { Context } from './context.js';
import { DaemonClient } from './daemon.js';
import { SCHEMA_RANGE_LOG, SchemaError, ToolError } from './errors.js';
import { createLogger, installStderrMask, type Logger } from './log.js';
import { createServer } from './server.js';
import { readListFile, TokenFileError } from './token.js';
import { SCHEMA_OLDEST, SCHEMA_TESTED, SDK_VERSION, SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * Start: parse options, answer --help and --version without contacting
 * anything, then serve MCP on stdio at once (hosts start servers before the
 * daemon often runs) and check the daemon once in the background. After that
 * check an idle server sends nothing. stdin closing ends the process.
 */

function versionText(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    `daemon schema: ${SCHEMA_OLDEST.major}.${SCHEMA_OLDEST.minor} to ${SCHEMA_TESTED.major}.${SCHEMA_TESTED.minor} tested,`
      + ` later ${SCHEMA_TESTED.major}.x accepted`,
    `MCP SDK: ${SDK_VERSION}`,
    `Node.js: ${process.versions.node}`,
  ].join('\n');
}

/**
 * The background startup check: health, token, controller list. One stderr
 * line with the outcome (codes only; for a schema this server does not read,
 * also the version the daemon reported, the range this server reads and the
 * side to update).
 */
export async function startupCheck(ctx: Context, log: Logger): Promise<void> {
  try {
    const ready = await ctx.readyWithoutReplayCheck();
    log.warn('startup', {
      daemon: 'ok', mode: ready.health.mode === 'replay' ? 'replay' : 'live', schema: ready.schema, controllers: ready.ids.length,
      replayAllowed: ctx.config.allowReplay,
    });
  } catch (e) {
    const schema = e instanceof SchemaError ? { schema: e.reported ?? 'unreadable', needed: SCHEMA_RANGE_LOG, update: e.update } : {};
    log.warn('startup', { daemon: e instanceof ToolError ? e.code : 'INTERNAL_ERROR', port: ctx.config.port, ...schema });
  }
}

async function run(config: Config): Promise<void> {
  const log = createLogger(config.logLevel);
  const daemon = new DaemonClient({ port: config.port, hostHeader: config.hostHeader, tokenFile: config.tokenFile, log });
  const ctx = new Context(config, daemon, log);
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  const stop = (): void => {
    daemon.close();
    process.exit(0);
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  transport.onclose = stop;
  await server.connect(transport);
  log.info('started', { version: SERVER_VERSION, port: config.port, motionSampling: config.motionSampling, allowReplay: config.allowReplay });
  void startupCheck(ctx, log);
}

export async function main(argv: readonly string[]): Promise<void> {
  installStderrMask();
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : 'the options could not be read';
    process.stderr.write(`abb-rws-mcp: ${msg}\n`);
    process.exit(1);
  }
  if (parsed.kind === 'help') { process.stdout.write(USAGE); return; }
  if (parsed.kind === 'version') { process.stdout.write(`${versionText()}\n`); return; }
  let config = parsed.config;
  if (config.markCodesFile) {
    // Read and checked before any MCP message; the path never goes into the line.
    try {
      config = { ...config, markCodes: parseCodeList(await readListFile(config.markCodesFile)) };
    } catch (e) {
      const msg = e instanceof ConfigError ? e.message : `the mark-codes file could not be read (${e instanceof TokenFileError ? e.reason : 'unreadable'})`;
      process.stderr.write(`abb-rws-mcp: ${msg}\n`);
      process.exit(1);
    }
  }
  await run(config);
}

main(process.argv.slice(2)).catch(e => {
  process.stderr.write(`abb-rws-mcp: could not start (${e instanceof Error ? e.name : 'unknown error'})\n`);
  process.exit(1);
});

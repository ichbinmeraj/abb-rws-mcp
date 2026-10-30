import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { LOG_LEVELS, type LogLevel } from './log.js';

/**
 * Options and environment variables. An option wins over its variable; an
 * empty variable counts as unset. A bad value is refused at start with one
 * line, before any MCP message.
 */

export const DEFAULT_DAEMON_PORT = 7810;
export const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;

export interface Config {
  /** The daemon's port on 127.0.0.1. */
  port: number;
  /** The Host header sent: `127.0.0.1:<port>` or `localhost:<port>`. The connection always goes to 127.0.0.1. */
  hostHeader: string;
  /** The daemon's token file. */
  tokenFile: string;
  allowReplay: boolean;
  motionSampling: boolean;
  logLevel: LogLevel;
  /** The mark-codes file named by --mark-codes, read at start (cli.ts); null when none was given. */
  markCodesFile?: string | null;
  /** Event codes whose events are marked (`marked: true`), from that file; null when none was given. */
  markCodes?: ReadonlySet<number> | null;
}

export type ParsedArgs =
  | { kind: 'run'; config: Config }
  | { kind: 'help' }
  | { kind: 'version' };

export class ConfigError extends Error {}

export const ENV = {
  daemonUrl: 'ABB_RWS_MCP_DAEMON_URL',
  tokenFile: 'ABB_RWS_DAEMON_TOKEN_FILE',
  allowReplay: 'ABB_RWS_MCP_ALLOW_REPLAY',
  motionSampling: 'ABB_RWS_MCP_MOTION_SAMPLING',
  log: 'ABB_RWS_MCP_LOG',
  markCodes: 'ABB_RWS_MCP_MARK_CODES',
} as const;

export const USAGE = `abb-rws-mcp: a read-only MCP server (stdio) for ABB robot controllers,
reading through abb-rws-daemon on 127.0.0.1.

Usage: abb-rws-mcp [options]

Options:
  --daemon-url <url>          The daemon's address (${ENV.daemonUrl}).
                              Default ${DEFAULT_DAEMON_URL}. http only, host 127.0.0.1
                              or localhost, with a port; nothing else is accepted.
  --token-file <file>         The daemon's token file (${ENV.tokenFile}).
                              Default: the daemon's own default location.
  --allow-replay              Read a daemon that replays a recording (${ENV.allowReplay}).
                              Off by default. Every answer is then labelled REPLAY.
  --motion-sampling <on|off>  Let get_robot_position ask the daemon to sample joint
                              positions for 15 s (${ENV.motionSampling}). Default on.
  --mark-codes <file>         Event codes, one per line (# starts a comment), whose
                              events get_event_log, explain_event and
                              summarize_controller mark with marked: true, to find
                              them before an answer is shared (${ENV.markCodes}).
                              Off by default: events then say marked: null.
  --help                      Print this text and exit.
  --version                   Print the versions and exit.

Environment:
  ${ENV.log}             error, warn (default), info or debug. Logs go to stderr.

This server only reads. It has no tool that changes a controller, the daemon,
files or anything else.
`;

/** The daemon's default token file, as the daemon computes it. */
export function defaultTokenPath(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home?: () => string,
): string {
  const homeDir = (): string => {
    let h = '';
    try { h = (home ?? homedir)(); } catch { h = ''; }
    if (!h) { throw new ConfigError('no home folder for this account: set the token file with --token-file'); }
    return h;
  };
  if (platform === 'win32') {
    const appData = env.APPDATA && win32.isAbsolute(env.APPDATA) ? env.APPDATA : win32.join(homeDir(), 'AppData', 'Roaming');
    return win32.join(appData, 'abb-rws-daemon', 'token');
  }
  const xdg = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(homeDir(), '.config');
  return posix.join(xdg, 'abb-rws-daemon', 'token');
}

/**
 * The daemon URL, checked: `http://127.0.0.1:<port>` or `http://localhost:<port>`,
 * an optional trailing `/`, nothing else. `[::1]` and every other host are refused.
 */
export function parseDaemonUrl(raw: string): { port: number; hostHeader: string } {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/i.exec(raw.trim());
  if (!m) {
    throw new ConfigError('the daemon URL must be http://127.0.0.1:<port> or http://localhost:<port>'
      + ' (no other host, no user, path, query or fragment)');
  }
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new ConfigError('the daemon URL has no valid port (1 to 65535)'); }
  return { port, hostHeader: `${m[1].toLowerCase()}:${port}` };
}

function parseBool(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) { return true; }
  if (['0', 'false', 'no', 'off'].includes(v)) { return false; }
  throw new ConfigError(`${name} must be on or off (or true/false, 1/0)`);
}

function parseOnOff(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'on') { return true; }
  if (v === 'off') { return false; }
  throw new ConfigError(`${name} must be on or off`);
}

/** The most codes a mark-codes file may list. */
export const MARK_CODES_MAX = 10_000;

/** A mark-codes file: one event code per line, `#` to the end of a line is a comment, blank lines skipped. */
export function parseCodeList(text: string): Set<number> {
  const codes = new Set<number>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (line === '') { continue; }
    if (!/^[0-9]{1,7}$/.test(line)) { throw new ConfigError(`line ${i + 1} of the mark-codes file is not an event code`); }
    codes.add(Number(line));
    if (codes.size > MARK_CODES_MAX) { throw new ConfigError(`the mark-codes file lists more than ${MARK_CODES_MAX} codes`); }
  }
  return codes;
}

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v);

/** Parse the command line and the environment. Throws ConfigError on a bad value. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ParsedArgs {
  const opts: { daemonUrl?: string; tokenFile?: string; allowReplay?: boolean; motionSampling?: string; markCodes?: string } = {};
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) { return inline; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { throw new ConfigError(`${flag} needs a value`); }
      i++;
      return next;
    };
    if (seen.has(flag)) { throw new ConfigError(`${flag} is given twice`); }
    seen.add(flag);
    switch (flag) {
      case '--help': case '-h': return { kind: 'help' };
      case '--version': case '-v': return { kind: 'version' };
      case '--daemon-url': opts.daemonUrl = value(); break;
      case '--token-file': opts.tokenFile = value(); break;
      case '--allow-replay':
        if (inline !== undefined) { throw new ConfigError('--allow-replay takes no value'); }
        opts.allowReplay = true;
        break;
      case '--motion-sampling': opts.motionSampling = value(); break;
      case '--mark-codes': opts.markCodes = value(); break;
      default: throw new ConfigError(`unknown option ${flag.length > 40 ? `${flag.slice(0, 40)}...` : flag} (see --help)`);
    }
  }

  const url = opts.daemonUrl ?? nonEmpty(env[ENV.daemonUrl]) ?? DEFAULT_DAEMON_URL;
  const { port, hostHeader } = parseDaemonUrl(url);

  const tokenFileRaw = opts.tokenFile ?? nonEmpty(env[ENV.tokenFile]);
  if (tokenFileRaw !== undefined && tokenFileRaw.trim() === '') { throw new ConfigError('--token-file is empty'); }
  const tokenFile = tokenFileRaw ?? defaultTokenPath(env, platform);

  const replayEnv = nonEmpty(env[ENV.allowReplay]);
  const allowReplay = opts.allowReplay ?? (replayEnv !== undefined ? parseBool(ENV.allowReplay, replayEnv) : false);

  const samplingRaw = opts.motionSampling ?? nonEmpty(env[ENV.motionSampling]);
  const motionSampling = samplingRaw !== undefined
    ? parseOnOff(opts.motionSampling !== undefined ? '--motion-sampling' : ENV.motionSampling, samplingRaw)
    : true;

  const logRaw = nonEmpty(env[ENV.log]);
  const logLevel = (logRaw?.trim().toLowerCase() ?? 'warn') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) { throw new ConfigError(`${ENV.log} must be one of ${LOG_LEVELS.join(', ')}`); }

  const markFile = opts.markCodes ?? nonEmpty(env[ENV.markCodes]);
  if (markFile !== undefined && markFile.trim() === '') { throw new ConfigError('--mark-codes is empty'); }
  const markCodesFile = markFile ?? null;

  return { kind: 'run', config: { port, hostHeader, tokenFile, allowReplay, motionSampling, logLevel, markCodesFile } };
}

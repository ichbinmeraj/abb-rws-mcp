/**
 * Logging. stdout carries MCP messages only, so every log line goes to stderr.
 * Hosts keep stderr on disk, so a line carries codes, ids, route templates,
 * counts and durations: never controller text, never the token, and the token
 * file's path only at `debug`. The token is also masked in everything written
 * to stderr, the SDK's own output included (installStderrMask).
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** A log field value. Strings are reduced to a safe character set (`safeValue`). */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  readonly level: LogLevel;
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  /**
   * A `debug` line with one free-text value, the token file's path (it holds
   * the account name), JSON-quoted so it stays on one line.
   */
  debugPath(event: string, path: string): void;
  enabled(level: LogLevel): boolean;
}

const secrets = new Set<string>();

/** Mask this value from now on in everything written to stderr and in every masked text. */
export function addSecret(value: string): void {
  if (value.length >= 8) { secrets.add(value); }
}

/** The text with every known secret replaced by `[token]`. */
export function mask(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) { out = out.split(s).join('[token]'); }
  }
  return out;
}

let installed = false;

/**
 * Wrap `process.stderr.write` so that every chunk is masked before it leaves,
 * whoever writes it. Installed once, at startup.
 */
export function installStderrMask(stream: NodeJS.WriteStream = process.stderr): void {
  if (installed) { return; }
  installed = true;
  const original = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const wrapped = (chunk: unknown, ...rest: unknown[]): boolean => {
    let out = chunk;
    if (secrets.size > 0) {
      if (typeof chunk === 'string') {
        out = mask(chunk);
      } else if (chunk instanceof Uint8Array) {
        out = Buffer.from(mask(Buffer.from(chunk).toString('utf8')), 'utf8');
      }
    }
    return original(out, ...rest);
  };
  stream.write = wrapped as typeof stream.write;
}

/**
 * A log value as it may appear in a line: letters, digits and `_ . : / -`, at
 * most 80 characters. Anything else becomes `?`, so no controller text and no
 * control character reaches the log through a field.
 */
export function safeValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) { return '-'; }
  if (typeof value !== 'string') { return String(value); }
  const cut = value.length > 80 ? value.slice(0, 80) : value;
  return cut.replace(/[^A-Za-z0-9_.:/-]/g, '?') || '-';
}

export function createLogger(level: LogLevel, write: (line: string) => void = line => { process.stderr.write(line); }): Logger {
  const enabled = (l: LogLevel): boolean => RANK[l] <= RANK[level];
  const emit = (l: LogLevel, event: string, fields?: LogFields): void => {
    if (!enabled(l)) { return; }
    const parts = [`abb-rws-mcp ${l} ${safeValue(event)}`];
    for (const [k, v] of Object.entries(fields ?? {})) { parts.push(`${safeValue(k)}=${safeValue(v)}`); }
    write(`${mask(parts.join(' '))}\n`);
  };
  return {
    level,
    enabled,
    error: (e, f) => emit('error', e, f),
    warn: (e, f) => emit('warn', e, f),
    info: (e, f) => emit('info', e, f),
    debug: (e, f) => emit('debug', e, f),
    debugPath: (e, path): void => {
      if (enabled('debug')) { write(`${mask(`abb-rws-mcp debug ${safeValue(e)} path=${JSON.stringify(path)}`)}\n`); }
    },
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = createLogger('error', () => {});

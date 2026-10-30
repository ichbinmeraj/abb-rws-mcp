/**
 * The errors a tool answers with: `[CODE] plain sentence.` from fixed text,
 * daemon ids, numbers and codes that match a strict pattern; controller text,
 * when there is any, goes into a controller-data block after the line. No text
 * carries a command, a variable name or a path to run or set.
 */

import { SCHEMA_OLDEST, SCHEMA_RAPID_VALUE, SCHEMA_TESTED } from './version.js';

export type ErrorCode =
  | 'DAEMON_UNREACHABLE' | 'NOT_A_DAEMON' | 'TOKEN_UNREADABLE' | 'TOKEN_REFUSED' | 'HOST_REFUSED'
  | 'SCHEMA_UNSUPPORTED' | 'REPLAY_REFUSED' | 'UNKNOWN_CONTROLLER' | 'CONTROLLER_REQUIRED' | 'WRONG_CONTROLLER'
  | 'NOT_READY' | 'BUSY' | 'SEARCH_TOO_WIDE' | 'NOT_FOUND' | 'CONTROLLER_UNAVAILABLE' | 'CONTROLLER_ERROR'
  | 'DAEMON_ERROR' | 'UNEXPECTED_ANSWER' | 'INTERNAL_ERROR'
  | 'SYMBOL_NOT_FOUND' | 'VALUE_NOT_READ' | 'DAEMON_TOO_OLD' | 'FEED_CHANGED' | 'FEED_NEEDED';

/** A daemon id as the daemon makes them (its ID_PATTERN): safe to show in fixed text. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A daemon or client error code that may appear in a line. */
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** The sentence after `[CODE]`, fixed text only. */
    readonly sentence: string,
    /** Controller or daemon data shown in a block after the line. */
    readonly data?: unknown,
    /** Seconds to wait, for BUSY and NOT_READY. */
    readonly retryAfterS?: number,
  ) {
    super(`${code}: ${sentence}`);
    this.name = 'ToolError';
  }
}

/** Which side to update when the daemon serves a snapshot schema this server does not read. */
export type SchemaUpdate = 'abb-rws-mcp' | 'abb-rws-daemon' | 'recording' | 'unknown';

/**
 * SCHEMA_UNSUPPORTED, with the version the daemon reported (only when it reads
 * as major.minor) and the side to update, for the startup log line.
 */
export class SchemaError extends ToolError {
  constructor(sentence: string, readonly reported: string | null, readonly update: SchemaUpdate) {
    super('SCHEMA_UNSUPPORTED', sentence);
  }
}

/** The snapshot schemas this server reads, as text: "0.13 or a later 0.x". */
const SCHEMA_RANGE = `${SCHEMA_OLDEST.major}.${SCHEMA_OLDEST.minor} or a later ${SCHEMA_OLDEST.major}.x`;

/** The same range for a log field (letters, digits and `.-` only): "0.13-0.x". */
export const SCHEMA_RANGE_LOG = `${SCHEMA_OLDEST.major}.${SCHEMA_OLDEST.minor}-${SCHEMA_OLDEST.major}.x`;

/**
 * The error for a schema this server does not read, saying which side is
 * older: a newer major asks for a newer abb-rws-mcp, an older schema for a
 * newer daemon, or, while the daemon replays, for a newer recording (the
 * daemon then reports the recording's schema).
 */
function schemaUnsupported(reported: string, replay: boolean): SchemaError {
  const needs = `This server needs abb-rws-daemon 0.1.0 or a later ${SCHEMA_TESTED.major}.x.`;
  const m = /^([0-9]{1,4})\.([0-9]{1,4})$/.exec(reported);
  if (!m) {
    return new SchemaError(`The daemon reported a snapshot schema version this server cannot read. ${needs}`
      + ' Ask the person to check the versions of both.', null, 'unknown');
  }
  const v = `${Number(m[1])}.${Number(m[2])}`;
  const what = replay ? 'The recording the daemon replays has' : 'The daemon serves';
  if (Number(m[1]) > SCHEMA_TESTED.major) {
    return new SchemaError(`${what} snapshot schema ${v}, newer than this server reads (${SCHEMA_RANGE}). Ask the person to update abb-rws-mcp.`, v, 'abb-rws-mcp');
  }
  if (replay) {
    return new SchemaError(`${what} snapshot schema ${v}, older than this server reads (${SCHEMA_RANGE}).`
      + ' Ask the person to replay a recording made with abb-rws-daemon 0.1.0 or later.', v, 'recording');
  }
  return new SchemaError(`${what} snapshot schema ${v}. ${needs} Ask the person to update the daemon.`, v, 'abb-rws-daemon');
}

/** Ids that may be listed in a line: those that match ID_PATTERN, at most 20. */
export function listIds(ids: readonly string[]): string {
  const ok = ids.filter(id => ID_PATTERN.test(id));
  if (ok.length === 0) { return 'none'; }
  const shown = ok.slice(0, 20).join(', ');
  return ok.length > 20 ? `${shown} and ${ok.length - 20} more` : shown;
}

export const errors = {
  daemonUnreachable: (port: number): ToolError => new ToolError('DAEMON_UNREACHABLE',
    `abb-rws-daemon is not answering at 127.0.0.1:${port}. Ask the person to start it.`),
  notADaemon: (port: number): ToolError => new ToolError('NOT_A_DAEMON',
    `Something other than abb-rws-daemon answers at 127.0.0.1:${port}. The token was not sent. Ask the person to check the daemon's port.`),
  tokenUnreadable: (): ToolError => new ToolError('TOKEN_UNREADABLE',
    "The daemon's token file could not be read. Ask the person to check that the daemon has run under this account, or to point this server at its token file."),
  tokenRefused: (): ToolError => new ToolError('TOKEN_REFUSED',
    'The daemon refused the token. It may use another token file; the person can point this server at it.'),
  hostRefused: (): ToolError => new ToolError('HOST_REFUSED',
    'The daemon refused the host name. This is not expected on loopback.'),
  schemaUnsupported,
  replayRefused: (): ToolError => new ToolError('REPLAY_REFUSED',
    'The daemon is replaying a recording, not reading a live robot. Reading a replay is off; the person can turn it on.'),
  unknownController: (ids: readonly string[]): ToolError => new ToolError('UNKNOWN_CONTROLLER',
    `No controller with that id. Known ids: ${listIds(ids)}. The person adds controllers in the daemon; this server cannot.`),
  controllerRequired: (ids: readonly string[]): ToolError => new ToolError('CONTROLLER_REQUIRED',
    ids.length === 0
      ? 'The daemon has no controller. The person adds controllers in the daemon; this server cannot.'
      : `The daemon has ${ids.length} controllers. Name one with the controller input. Known ids: ${listIds(ids)}.`),
  wrongController: (): ToolError => new ToolError('WRONG_CONTROLLER',
    'The address answers as a different controller. No values are shown.'),
  notReady: (retryS: number): ToolError => new ToolError('NOT_READY',
    `The signal table is not read yet on this connection. Retry in ${retryS} s.`, undefined, retryS),
  busy: (retryS: number): ToolError => new ToolError('BUSY',
    `The controller's read budget is in use. Retry in ${retryS} s.`, undefined, retryS),
  searchTooWide: (): ToolError => new ToolError('SEARCH_TOO_WIDE',
    'This search would make many controller requests. Add a name prefix of at least 3 characters, or a device.'),
  notFound: (what: string, known?: unknown): ToolError => new ToolError('NOT_FOUND',
    `No such ${what}.${known !== undefined ? ' The names known follow, in a block.' : ''}`, known),
  controllerUnavailable: (code: string): ToolError => new ToolError('CONTROLLER_UNAVAILABLE',
    `The daemon could not read the controller just now (${CODE_PATTERN.test(code) ? code : 'no code'}). Retry later; get_controller_status shows the link.`),
  controllerError: (code: string | null, data: unknown): ToolError => new ToolError('CONTROLLER_ERROR',
    `The controller or the daemon refused the read${code && CODE_PATTERN.test(code) ? ` (${code})` : ''}.`
      + (data !== undefined ? ' What it answered follows, in a block.' : ''), data),
  daemonError: (): ToolError => new ToolError('DAEMON_ERROR',
    "The daemon reported an internal error. Its log has more."),
  unexpected: (path?: string): ToolError => new ToolError('UNEXPECTED_ANSWER',
    path ? `The daemon's answer does not have the expected shape (at ${path}).` : "The daemon's answer does not have the expected shape."),
  redirect: (): ToolError => new ToolError('UNEXPECTED_ANSWER',
    'The daemon answered with a redirect. Redirects are never followed.'),
  tooLarge: (): ToolError => new ToolError('UNEXPECTED_ANSWER',
    "The daemon's answer is larger than 16 MiB and was not read."),
  internal: (): ToolError => new ToolError('INTERNAL_ERROR',
    'This server hit an internal error. Details are in its log.'),
  symbolNotFound: (data: unknown): ToolError => new ToolError('SYMBOL_NOT_FOUND',
    'The controller does not know that task, module or symbol. It does not say which of the three is missing.'
      + (data !== undefined ? ' What it answered follows, in a block.' : ''), data),
  valueNotRead: (): ToolError => new ToolError('VALUE_NOT_READ',
    'The controller answered the read with no value. It does so for an array over its read limit and for a type with no printable value. No value is shown.'),
  daemonTooOld: (reported: string | null): ToolError => new ToolError('DAEMON_TOO_OLD',
    `This tool needs abb-rws-daemon 0.1.1 or later (snapshot schema ${SCHEMA_RAPID_VALUE.major}.${SCHEMA_RAPID_VALUE.minor}).`
      + `${reported && /^[0-9]{1,4}\.[0-9]{1,4}$/.test(reported) ? ` The daemon serves ${reported}.` : ''} Ask the person to update the daemon. The other tools still work.`),
  recordingTooOld: (reported: string | null): ToolError => new ToolError('NOT_FOUND',
    `The daemon replays a recording made before RAPID values were recorded${reported && /^[0-9]{1,4}\.[0-9]{1,4}$/.test(reported) ? ` (snapshot schema ${reported})` : ''},`
      + ' so this tool has nothing to read from it. The other tools still work.'),
  feedNeeded: (): ToolError => new ToolError('FEED_NEEDED',
    'A seq is only known together with its feed: give the feed from the same get_event_log or summarize_controller answer, or name the event by code.'),
  feedChanged: (): ToolError => new ToolError('FEED_CHANGED',
    'The event numbering started over (the daemon restarted or the controller was added again). Call get_event_log again for a current seq.'),
};

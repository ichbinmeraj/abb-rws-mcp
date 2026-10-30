import { z } from 'zod';
import type { Context } from '../context.js';
import { schemaStatus, type SchemaStatus } from '../context.js';
import { answerError } from '../daemon.js';
import { cleanDeep } from '../clean.js';
import { ID_PATTERN, ToolError, errors } from '../errors.js';
import { CTRL_STATE, EXEC_STATE, OP_MODE, knownValue } from '../meanings.js';
import { LEVELS, NOTE, QUALITIES, ageS, known, newNonce, utcDate, validTime, when, who } from '../render.js';
import { ControllerListHead, Snapshot, type Health } from '../schema.js';
import { SCHEMA_TESTED, SERVER_VERSION } from '../version.js';
import { ANNOTATIONS, DESCRIPTION_TAIL, dataBlock, ok } from './common.js';

export const NAME = 'list_controllers';
export const DESCRIPTION = "Lists the controllers the daemon knows, and the daemon's own state. Call it first, and when other tools fail."
  + DESCRIPTION_TAIL;

export const LIST_MAX = 50;

const DaemonOut = z.object({
  reachable: z.boolean(),
  port: z.number(),
  version: z.string().nullable(),
  mode: z.enum(['live', 'replay', 'unknown']).nullable(),
  startedAt: z.string().nullable(),
  uptimeS: z.number().nullable(),
  recording: z.object({ active: z.boolean(), since: z.string().nullable() }).nullable(),
  replay: z.object({ state: z.string(), recordedAt: z.string().nullable(), positionMs: z.number(), durationMs: z.number() }).nullable(),
});

const ControllerOut = z.object({
  id: z.string(),
  link: z.object({
    quality: z.enum([...QUALITIES, 'unknown']),
    mode: z.enum(['live', 'replay', 'unknown']),
    since: z.string().nullable(),
    ageS: z.number().nullable(),
    downSince: z.string().nullable(),
    identityCheck: z.enum(['confirmed', 'unverified', 'mismatch', 'unknown']),
  }),
  freshness: z.object({ level: z.enum([...LEVELS, 'unknown']) }),
  identity: z.object({
    virtual: z.boolean().nullable(),
    robotWare: z.object({ major: z.number().nullable(), minor: z.number().nullable() }),
  }).nullable(),
  capabilities: z.object({ tested: z.boolean().nullable() }),
  panel: z.object({ ctrlState: z.string().nullable(), opMode: z.string().nullable() }),
  rapid: z.object({ execState: z.string().nullable() }),
  state: z.string().nullable(),
  controllerData: z.object({
    name: z.string(),
    controllerName: z.string().nullable(),
    controllerType: z.string().nullable(),
    systemName: z.string().nullable(),
    freshnessReasons: z.array(z.string()),
    ctrlStateReported: z.string().nullable(),
    opModeReported: z.string().nullable(),
  }),
});

export const OUTPUT = z.object({
  now: z.string(),
  note: z.string(),
  daemon: DaemonOut,
  schema: z.object({ version: z.string().nullable(), status: z.enum(['tested', 'untested-newer', 'unsupported', 'unknown']) }),
  token: z.enum(['ok', 'unreadable', 'refused', 'unknown']),
  server: z.object({ version: z.string(), motionSampling: z.boolean(), allowReplay: z.boolean() }),
  problem: z.object({ code: z.string(), text: z.string() }).nullable(),
  controllers: z.array(ControllerOut),
  truncated: z.boolean(),
});

type Out = z.infer<typeof OUTPUT>;

const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,40}$/;

const CTRL_WORDS: Record<string, string> = {
  init: 'starting up', motoroff: 'motors off', motoron: 'motors on', guardstop: 'guard stop',
  emergencystop: 'emergency stop', emergencystopreset: 'emergency stop reset', sysfail: 'system failure',
};
const MODE_WORDS: Record<string, string> = { AUTO: 'Auto', MANR: 'manual reduced speed', MANF: 'manual full speed' };
const EXEC_WORDS: Record<string, string> = { running: 'running', stopped: 'stopped' };

/**
 * One line per controller from the list answer alone: controller state,
 * operating mode, program state ("motors on, Auto, running"). A value that is
 * not known says so. It reads no lock, holder or access field.
 */
export function stateLine(ctrlState: string | null, opMode: string | null, execState: string | null): string {
  return [
    ctrlState !== null ? CTRL_WORDS[ctrlState] ?? 'controller state not known' : 'controller state not known',
    opMode !== null ? MODE_WORDS[opMode] ?? 'mode not known' : 'mode not known',
    execState !== null ? EXEC_WORDS[execState] ?? 'program state not known' : 'program state not known',
  ].join(', ');
}

function daemonOut(health: Health | null, port: number, now: number): Out['daemon'] {
  if (!health) {
    return { reachable: false, port, version: null, mode: null, startedAt: null, uptimeS: null, recording: null, replay: null };
  }
  return {
    reachable: true,
    port,
    version: VERSION_PATTERN.test(health.version) ? health.version : null,
    mode: health.mode === 'live' || health.mode === 'replay' ? health.mode : 'unknown',
    startedAt: validTime(health.startedAt),
    uptimeS: Number.isFinite(health.uptimeS) ? health.uptimeS : ageS(health.startedAt, now),
    recording: health.recording ? { active: health.recording.active, since: validTime(health.recording.since) } : null,
    replay: health.replay ? {
      state: ['playing', 'paused', 'ended'].includes(health.replay.state) ? health.replay.state : 'unknown',
      recordedAt: validTime(health.replay.recordedAt),
      positionMs: health.replay.positionMs,
      durationMs: health.replay.durationMs,
    } : null,
  };
}

export async function listControllers(ctx: Context): Promise<ReturnType<typeof ok>> {
  const now = ctx.now();
  const nonce = newNonce();
  const out: Out = {
    now: new Date(now).toISOString(),
    note: NOTE,
    daemon: daemonOut(null, ctx.config.port, now),
    schema: { version: null, status: 'unknown' },
    token: 'unknown',
    server: { version: SERVER_VERSION, motionSampling: ctx.config.motionSampling, allowReplay: ctx.config.allowReplay },
    problem: null,
    controllers: [],
    truncated: false,
  };
  const lines: string[] = [];
  const problem = (e: ToolError): void => {
    out.problem = { code: e.code, text: e.sentence };
    lines.push(`[${e.code}] ${e.sentence}`);
  };

  let health: Health | null = null;
  try {
    health = await ctx.daemon.health();
    out.daemon = daemonOut(health, ctx.config.port, now);
  } catch (e) {
    if (!(e instanceof ToolError)) { throw e; }
    problem(e);
    return ok(lines.join('\n'), out);
  }

  const d = out.daemon;
  lines.push(`abb-rws-daemon ${d.version ?? '(version not shown)'} at 127.0.0.1:${ctx.config.port}: ${d.mode === 'replay' ? 'REPLAYING a recording' : d.mode === 'live' ? 'live' : 'mode not a known value'}, started ${when(d.startedAt, now)}.`);
  if (d.recording?.active) { lines.push(`The daemon is recording since ${when(d.recording.since, now)}: the reads this server causes are in its recording.`); }
  if (d.mode === 'replay') {
    const made = utcDate(d.replay?.recordedAt);
    lines.push(`Replay of a recording${made ? ` made ${made}` : ''}: every value is recorded, not live.`);
    if (!ctx.config.allowReplay) {
      problem(new ToolError('REPLAY_REFUSED', 'The daemon is replaying a recording, not reading a live robot. Reading a replay is off; the person can turn it on.'));
    }
  }

  let body: unknown;
  try {
    const ans = await ctx.daemon.get('controllers');
    out.token = ctx.daemon.tokenState;
    if (ans.status !== 200) { throw answerError(ans); }
    body = ans.body;
  } catch (e) {
    if (!(e instanceof ToolError)) { throw e; }
    out.token = ctx.daemon.tokenState;
    problem(e);
    return ok(lines.join('\n'), out);
  }

  const head = ControllerListHead.safeParse(body);
  if (!head.success) {
    problem(new ToolError('UNEXPECTED_ANSWER', "The daemon's answer does not have the expected shape (at controllers)."));
    return ok(lines.join('\n'), out);
  }
  const st: SchemaStatus = schemaStatus(head.data.schemaVersion);
  out.schema = { version: /^[0-9]{1,4}\.[0-9]{1,4}$/.test(head.data.schemaVersion) ? head.data.schemaVersion : null, status: st };
  if (st === 'unsupported') {
    problem(errors.schemaUnsupported(head.data.schemaVersion, health.mode === 'replay'));
    return ok(lines.join('\n'), out);
  }
  lines.push(st === 'tested'
    ? `Snapshot schema ${out.schema.version}, one this server was tested with.`
    : `Snapshot schema ${out.schema.version ?? '(not shown)'} is newer than the newest one this server was tested with`
      + ` (${SCHEMA_TESTED.major}.${SCHEMA_TESTED.minor}). Unknown values show as not known.`);

  const data: Record<string, unknown>[] = [];
  const ctrlLines: string[] = [];
  let skipped = 0;
  for (const raw of head.data.controllers) {
    const r = Snapshot.safeParse(raw);
    if (!r.success || !ID_PATTERN.test(r.data.id)) { skipped++; continue; }
    if (out.controllers.length >= LIST_MAX) { out.truncated = true; continue; }
    const s = r.data;
    const level = known(s.freshness.level, LEVELS) ?? 'unknown';
    const quality = known(s.link.quality, QUALITIES) ?? 'unknown';
    const mode = s.link.mode === 'live' || s.link.mode === 'replay' ? s.link.mode : (s.link.mode === undefined ? (health.mode === 'replay' ? 'replay' : 'live') : 'unknown');
    const check = known(s.link.identityCheck.status, ['confirmed', 'unverified', 'mismatch'] as const) ?? 'unknown';
    const wrong = check === 'mismatch' || level === 'wrong-controller';
    out.controllers.push({
      id: s.id,
      link: { quality, mode, since: validTime(s.link.since), ageS: ageS(s.link.since, now), downSince: validTime(s.link.downSince), identityCheck: check },
      freshness: { level },
      identity: s.identity && !wrong ? { virtual: s.identity.virtual, robotWare: { major: s.identity.robotWare.major, minor: s.identity.robotWare.minor } } : null,
      capabilities: { tested: s.capabilities.tested },
      panel: { ctrlState: wrong ? null : knownValue(CTRL_STATE, s.panel.ctrlState), opMode: wrong ? null : knownValue(OP_MODE, s.panel.opMode) },
      rapid: { execState: wrong ? null : knownValue(EXEC_STATE, s.rapid.execState) },
      // A state that is not current says so in the field itself, not only in freshness.
      state: wrong ? null : `${level === 'current' ? '' : 'last known: '}${stateLine(knownValue(CTRL_STATE, s.panel.ctrlState), knownValue(OP_MODE, s.panel.opMode), knownValue(EXEC_STATE, s.rapid.execState))}`,
      controllerData: cleanDeep({
        name: s.name,
        controllerName: wrong ? null : s.identity?.controllerName ?? null,
        controllerType: wrong ? null : s.identity?.controllerType ?? null,
        systemName: wrong ? null : s.identity?.systemName ?? null,
        freshnessReasons: s.freshness.reasons,
        ctrlStateReported: wrong ? null : s.panel.ctrlState,
        opModeReported: wrong ? null : s.panel.opMode,
      }),
    });
    const c = out.controllers[out.controllers.length - 1];
    const state = wrong ? 'WRONG CONTROLLER on this address, no values'
      : [
        mode === 'replay' ? 'REPLAY' : `link ${quality}`,
        level === 'current' ? 'current' : level.toUpperCase(),
        c.state ?? 'state not known',
      ].join(', ');
    ctrlLines.push(`- ${who(s)}: ${state}.`);
    data.push({ id: s.id, ...c.controllerData });
  }
  if (out.controllers.length === 0 && skipped === 0) {
    lines.push('The daemon has no controller. The person adds controllers in the daemon; this server cannot.');
  } else {
    lines.push(`Controllers (${out.controllers.length}${out.truncated ? `, the first ${LIST_MAX}` : ''}):`, ...ctrlLines);
  }
  if (skipped > 0) { lines.push(`${skipped} controller entries could not be read and are not listed.`); }
  if (data.length > 0) { lines.push(dataBlock(nonce, { controllers: data }, now)); }
  return ok(lines.join('\n'), out);
}


export const INPUT = {};
export const annotations = ANNOTATIONS;

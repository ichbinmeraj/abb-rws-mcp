import { z } from 'zod';
import { cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { CODE_PATTERN } from '../errors.js';
import { COLLISION, CTRL_STATE, CYCLE, EXEC_STATE, OP_MODE, knownValue, meaning } from '../meanings.js';
import { QUALITIES, ageS, known, validTime, when } from '../render.js';
import { ANNOTATIONS, DESCRIPTION_TAIL, commonShape, controllerInput, dataBlock, header, ok, reasons, scoped } from './common.js';

export const NAME = 'get_controller_status';
export const DESCRIPTION = 'Controller status: motors and controller state, operating mode, speed override, collision detection, RAPID execution,'
  + ' the link, what the daemon can read on this controller, and the access status as the controller reported it.'
  + DESCRIPTION_TAIL;

export const INPUT = {
  controller: controllerInput,
  includeOptions: z.boolean().optional().describe('Also return the controller and system names, the exact RobotWare version and the options list.'),
};

const CAPABILITY_IDS = ['status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp'] as const;
const CAPABILITY_STATES = ['available', 'unavailable', 'degraded', 'unknown'] as const;
const LOCKS = ['cfg', 'motion', 'rapid', 'edit', 'writeaccess'] as const;
const HOLDER_KINDS = ['local', 'remote', 'internal', 'station'] as const;
export const OPTIONS_MAX = 200;

export const OUTPUT = z.object({
  ...commonShape,
  identity: z.object({ virtual: z.boolean().nullable(), robotWare: z.object({ major: z.number().nullable(), minor: z.number().nullable() }) }).nullable(),
  panel: z.object({
    ctrlState: z.string().nullable(), opMode: z.string().nullable(), speedRatio: z.number().nullable(), collisionDetection: z.string().nullable(),
    asOf: z.string().nullable(), ageS: z.number().nullable(),
    meanings: z.object({ ctrlState: z.string(), opMode: z.string(), collisionDetection: z.string() }),
  }),
  rapid: z.object({
    execState: z.string().nullable(), cycle: z.string().nullable(), asOf: z.string().nullable(), ageS: z.number().nullable(),
    meanings: z.object({ execState: z.string(), cycle: z.string() }),
  }),
  capabilities: z.object({
    protocol: z.enum(['rws1', 'rws2']).nullable(),
    generation: z.enum(['rw6', 'rw7', 'rw8']).nullable(),
    tested: z.boolean().nullable(),
    notAvailable: z.array(z.object({ id: z.string(), state: z.string() })),
  }),
  link: z.object({ quality: z.string(), since: z.string().nullable(), ageS: z.number().nullable(), downSince: z.string().nullable() }),
  access: z.object({
    model: z.enum(['mastership', 'writeaccess']).nullable(),
    locks: z.array(z.object({
      lock: z.string(), held: z.boolean().nullable(), holder: z.object({ kind: z.string() }).nullable(),
      asOf: z.string().nullable(), ageS: z.number().nullable(), errorCode: z.string().nullable(),
    })),
    remoteAccessEnabled: z.boolean().nullable(),
    problem: z.boolean(),
    asOf: z.string().nullable(),
  }),
  controllerData: z.looseObject({}),
});

export async function getControllerStatus(ctx: Context, args: { controller?: string; includeOptions?: boolean }): Promise<ReturnType<typeof ok>> {
  const s = await scoped(ctx, args.controller);
  const { snap, now } = s;
  const { common, lines } = header(s, ['identity', 'panel', 'rapid', 'access']);
  const p = snap.panel;
  const r = snap.rapid;
  const a = snap.access;
  const caps = snap.capabilities;

  const panel = {
    ctrlState: knownValue(CTRL_STATE, p.ctrlState),
    opMode: knownValue(OP_MODE, p.opMode),
    speedRatio: typeof p.speedRatio === 'number' && Number.isFinite(p.speedRatio) ? p.speedRatio : null,
    collisionDetection: knownValue(COLLISION, p.collisionDetection),
    asOf: validTime(p.asOf), ageS: ageS(p.asOf, now),
    meanings: { ctrlState: meaning(CTRL_STATE, p.ctrlState), opMode: meaning(OP_MODE, p.opMode), collisionDetection: meaning(COLLISION, p.collisionDetection) },
  };
  const rapid = {
    execState: knownValue(EXEC_STATE, r.execState),
    cycle: knownValue(CYCLE, r.cycle),
    asOf: validTime(r.asOf), ageS: ageS(r.asOf, now),
    meanings: { execState: meaning(EXEC_STATE, r.execState), cycle: meaning(CYCLE, r.cycle) },
  };
  const capabilities = {
    protocol: known(caps.protocol, ['rws1', 'rws2'] as const),
    generation: known(caps.generation, ['rw6', 'rw7', 'rw8'] as const),
    tested: caps.tested,
    notAvailable: caps.entries.filter(e => e.state !== 'available').map(e => ({
      id: known(e.id, CAPABILITY_IDS) ?? 'unknown', state: known(e.state, CAPABILITY_STATES) ?? 'unknown',
    })),
  };
  const link = {
    quality: known(snap.link.quality, QUALITIES) ?? 'unknown',
    since: validTime(snap.link.since), ageS: ageS(snap.link.since, now), downSince: validTime(snap.link.downSince),
  };
  const access = {
    model: known(a.model, ['mastership', 'writeaccess'] as const),
    locks: a.locks.map(l => ({
      lock: known(l.lock, LOCKS) ?? 'unknown',
      held: l.held,
      holder: l.holder ? { kind: known(l.holder.kind, HOLDER_KINDS) ?? 'unknown' } : null,
      asOf: validTime(l.asOf), ageS: ageS(l.asOf, now),
      errorCode: l.error && CODE_PATTERN.test(l.error.code) ? l.error.code : null,
    })),
    remoteAccessEnabled: a.remoteAccessEnabled,
    problem: a.problem !== null,
    asOf: validTime(a.asOf),
  };
  const identity = snap.identity
    ? { virtual: snap.identity.virtual, robotWare: { major: snap.identity.robotWare.major, minor: snap.identity.robotWare.minor } }
    : null;

  const options = snap.identity?.options ?? [];
  const controllerData = cleanDeep({
    ...(args.includeOptions ? {
      identity: {
        controllerName: snap.identity?.controllerName ?? null,
        controllerType: snap.identity?.controllerType ?? null,
        systemName: snap.identity?.systemName ?? null,
        robotWareRaw: snap.identity?.robotWare.raw ?? null,
        options: options.slice(0, OPTIONS_MAX),
        optionsTruncated: options.length > OPTIONS_MAX,
      },
    } : {}),
    reported: {
      ctrlState: panel.ctrlState === null ? p.ctrlState : undefined,
      opMode: panel.opMode === null ? p.opMode : undefined,
      collisionDetection: panel.collisionDetection === null ? p.collisionDetection : undefined,
      cycle: rapid.cycle === null ? r.cycle : undefined,
    },
    ...reasons(snap, ['identity', 'panel', 'rapid', 'access']),
    capabilities: { robotWare: caps.robotWare, reasons: caps.entries.filter(e => e.reason).map(e => ({ id: e.id, reason: e.reason })) },
    access: {
      problem: a.problem,
      locks: a.locks.map(l => ({
        lock: l.lock, holderName: l.holder?.name ?? null, holderApplication: l.holder?.application ?? null,
        error: l.error ? { code: l.error.code, message: l.error.message } : null,
      })),
      rmmp: { supported: a.rmmp.supported, privilege: a.rmmp.privilege, error: a.rmmp.error?.message ?? null },
    },
  });
  stripUndefined(controllerData);

  const t: string[] = [...lines];
  t.push(`Controller state: ${panel.ctrlState ?? (p.ctrlState === null ? 'not read yet' : 'not a known value (in the block)')}. ${panel.ctrlState ? panel.meanings.ctrlState : ''}`.trim());
  t.push(`Operating mode: ${panel.opMode ?? (p.opMode === null ? 'not read yet' : 'not a known value (in the block)')}. ${panel.opMode ? panel.meanings.opMode : ''}`.trim());
  t.push(`Speed override: ${panel.speedRatio !== null ? `${panel.speedRatio} %` : 'not read yet'}.`);
  t.push(`Collision detection: ${panel.collisionDetection ?? (p.collisionDetection === null ? 'not read yet' : 'not a known value (in the block)')}${panel.collisionDetection ? `. ${panel.meanings.collisionDetection}` : '.'}`);
  t.push(`Panel values as of ${when(p.asOf, now)}.`);
  t.push(`RAPID: ${rapid.execState ? `program ${rapid.execState}` : 'execution state not read yet'}; cycle ${rapid.cycle ?? (r.cycle === null ? 'not read yet' : 'not a known value')}; as of ${when(r.asOf, now)}.`);
  t.push(`Link: ${link.quality}, since ${when(snap.link.since, now)}${link.downSince ? `; not healthy since ${when(snap.link.downSince, now)}` : ''}.`);
  t.push(`Capabilities: ${capabilities.protocol ?? 'protocol not known'}, ${capabilities.generation ?? 'generation not known'}, ${caps.tested === true ? 'a RobotWare version the daemon was tested with' : caps.tested === false ? 'a RobotWare version the daemon was NOT tested with' : 'tested status not known'}.`
    + (capabilities.notAvailable.length ? ` Not available now: ${capabilities.notAvailable.map(c => `${c.id} (${c.state})`).join(', ')}.` : ''));
  t.push(a.problem !== null
    ? 'Access: the daemon cannot read the access status of this controller (reason in the block). This server writes nothing.'
    : `Access as the controller reported it at ${when(a.asOf, now)}. It does not say whether a write would succeed. This server writes nothing.`);
  t.push(dataBlock(s.nonce, controllerData, now));

  return ok(t.join('\n'), { ...common, identity, panel, rapid, capabilities, link, access, controllerData });
}

function stripUndefined(o: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) { delete o[k]; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      stripUndefined(v as Record<string, unknown>);
      if (Object.keys(v).length === 0) { delete o[k]; }
    }
  }
}

export const annotations = ANNOTATIONS;

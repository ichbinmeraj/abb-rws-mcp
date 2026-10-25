import { z } from 'zod';
import { errors } from './errors.js';

/**
 * The daemon's answers (schema 0.13 and 0.14), as far as this server reads them.
 * Unknown fields are dropped; enum fields are read as text and checked against
 * the known values where they are used, so a later 0.x with a new value is
 * still read ("not a known value"). `link.host` and `link.port` are never read.
 */

const str = z.string();
const nstr = z.string().nullable();
const nnum = z.number().nullable();
const nbool = z.boolean().nullable();

export const ControllerAnswer = z.object({ httpStatus: nnum, code: nnum, message: nstr });

export const GroupError = z.object({
  code: str,
  message: str,
  controller: ControllerAnswer.optional(),
  refusal: z.record(z.string(), z.unknown()).optional(),
});
export type GroupError = z.infer<typeof GroupError>;

export const Identity = z.object({
  controllerName: nstr,
  controllerType: nstr,
  virtual: nbool,
  systemName: nstr,
  robotWare: z.object({ raw: nstr, major: nnum, minor: nnum, generation: nstr }),
  options: z.array(str),
  asOf: str,
});
export type Identity = z.infer<typeof Identity>;

export const Link = z.object({
  connected: z.boolean(),
  quality: str,
  qualityReason: str,
  since: str,
  downSince: nstr.optional(),
  identityCheck: z.object({ status: str }),
  mode: str.optional(),
  recordedAt: nstr.optional(),
});
export type Link = z.infer<typeof Link>;

export const Panel = z.object({ ctrlState: nstr, opMode: nstr, speedRatio: nnum, collisionDetection: nstr, asOf: nstr });
export type Panel = z.infer<typeof Panel>;

export const Pointer = z.object({ module: str, routine: nstr, line: nnum });
export type Pointer = z.infer<typeof Pointer>;

export const Task = z.object({
  name: str,
  type: str,
  taskState: nstr,
  execState: nstr,
  active: z.boolean(),
  motion: z.boolean(),
  modules: z.array(str),
  pp: Pointer.nullable(),
  mp: Pointer.nullable(),
});
export type Task = z.infer<typeof Task>;

export const Rapid = z.object({ execState: nstr, cycle: nstr, tasks: z.array(Task), asOf: nstr });
export type Rapid = z.infer<typeof Rapid>;

export const Joint = z.object({ name: str, value: nnum, unit: nstr, min: nnum, max: nnum });
export type Joint = z.infer<typeof Joint>;

export const Pose = z.object({
  x: z.number(), y: z.number(), z: z.number(),
  q: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  tool: nstr, wobj: nstr, coord: nstr,
});
export type Pose = z.infer<typeof Pose>;

export const MotionUnit = z.object({
  name: str, kind: nstr, typeRaw: nstr, task: nstr,
  joints: z.array(Joint), pose: Pose.nullable(), error: GroupError.nullable(),
});
export type MotionUnit = z.infer<typeof MotionUnit>;

export const Motion = z.object({
  watching: z.boolean(),
  units: z.array(MotionUnit),
  rate: z.object({ targetHz: nnum, achievedHz: nnum }),
  asOf: nstr,
});
export type Motion = z.infer<typeof Motion>;

export const WatchedSignal = z.object({ name: str, type: nstr, value: nstr, asOf: nstr, error: GroupError.nullable() });
export const Io = z.object({ watching: z.boolean(), signals: z.array(WatchedSignal), asOf: nstr });
export type Io = z.infer<typeof Io>;

export const EventArg = z.object({ type: str, value: str });

export const ControllerEvent = z.object({
  seq: z.number(),
  code: nnum,
  severity: nstr,
  title: str,
  titleFromCode: z.boolean(),
  description: nstr,
  causes: nstr,
  consequences: nstr,
  actions: nstr,
  args: z.array(EventArg),
  source: nstr,
  time: z.object({ raw: nstr, utc: nstr, corrected: z.boolean() }),
  receivedAt: str,
  backlog: z.boolean(),
});
export type ControllerEvent = z.infer<typeof ControllerEvent>;

export const Events = z.object({
  feed: nstr,
  lastSeq: z.number(),
  recent: z.array(ControllerEvent),
  via: nstr,
  clock: z.object({ offsetMs: nnum, measuredAt: nstr, problem: nstr }),
  asOf: nstr,
  error: GroupError.nullable(),
});
export type Events = z.infer<typeof Events>;

export const AccessLock = z.object({
  lock: str,
  held: nbool,
  // 0.14 adds holder.flexPendant; this server does not read it.
  holder: z.object({ kind: str, name: nstr, application: nstr }).nullable(),
  asOf: nstr,
  error: GroupError.nullable(),
});
export type AccessLock = z.infer<typeof AccessLock>;

export const Access = z.object({
  generation: nstr,
  model: nstr,
  locks: z.array(AccessLock),
  remoteAccessEnabled: nbool,
  rmmp: z.object({ supported: nbool, privilege: nstr, asOf: nstr, error: GroupError.nullable() }),
  via: nstr,
  problem: nstr,
  asOf: nstr,
});
export type Access = z.infer<typeof Access>;

export const Capabilities = z.object({
  protocol: nstr,
  generation: nstr,
  robotWare: nstr,
  tested: nbool,
  entries: z.array(z.object({ id: str, state: str, reason: nstr })),
  asOf: nstr,
});
export type Capabilities = z.infer<typeof Capabilities>;

export const GroupFreshness = z.object({ group: str, state: str, asOf: nstr, reason: nstr });
export const Freshness = z.object({ level: str, reasons: z.array(str), groups: z.array(GroupFreshness) });
export type Freshness = z.infer<typeof Freshness>;

export const Snapshot = z.object({
  id: str,
  name: str,
  identity: Identity.nullable(),
  link: Link,
  panel: Panel,
  rapid: Rapid,
  motion: Motion,
  io: Io,
  events: Events,
  access: Access,
  capabilities: Capabilities,
  freshness: Freshness,
});
export type Snapshot = z.infer<typeof Snapshot>;

/** `GET /v0/controllers`: the schema version is read first, on its own, so a newer shape is not misread. */
export const ControllerListHead = z.object({ schemaVersion: str, observedAt: str, controllers: z.array(z.unknown()) });

export const EventsPage = z.object({
  feed: str, firstSeq: z.number(), lastSeq: z.number(), gap: z.boolean(), more: z.boolean(),
  events: z.array(ControllerEvent),
});
export type EventsPage = z.infer<typeof EventsPage>;

export const SignalList = z.object({ signals: z.array(z.object({ name: str, type: nstr, value: nstr })) });
export type SignalList = z.infer<typeof SignalList>;

export const ModuleSource = z.object({ task: str, module: str, kind: nstr, text: str, changeCount: nnum });
export type ModuleSource = z.infer<typeof ModuleSource>;

export const MotionWatchAnswer = z.object({ leaseMs: z.number(), targetHz: z.number(), leaseId: str.optional() });
export type MotionWatchAnswer = z.infer<typeof MotionWatchAnswer>;

export const Health = z.object({
  status: z.literal('ok'),
  version: str,
  startedAt: str,
  uptimeS: z.number(),
  mode: str,
  recording: z.object({ active: z.boolean(), since: nstr }).optional(),
  replay: z.object({ state: str, recordedAt: str, positionMs: z.number(), durationMs: z.number() }).nullable().optional(),
});
export type Health = z.infer<typeof Health>;

export const ErrorBodySchema = z.object({
  error: str.optional(),
  code: str.optional(),
  controller: ControllerAnswer.optional(),
  refusal: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** A field path for an error line: schema keys only; anything else becomes `*`. */
export function fieldPath(path: readonly PropertyKey[]): string {
  return path.map(p => (typeof p === 'number' ? `[${p}]` : typeof p === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(p) ? p : '*'))
    .join('.').replace(/\.\[/g, '[') || '(root)';
}

/** Parse a daemon answer, or throw UNEXPECTED_ANSWER naming the failing field path. */
export function parseAnswer<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (r.success) { return r.data; }
  const issue = r.error.issues[0];
  throw errors.unexpected(`${what}.${fieldPath(issue?.path ?? [])}`);
}

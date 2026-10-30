import { z } from 'zod';
import { clean, cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { RAPID_NAME, answerError, errorBody } from '../daemon.js';
import { errors } from '../errors.js';
import { fence, when } from '../render.js';
import { RapidSymbolValue, parseAnswer } from '../schema.js';
import { SCHEMA_RAPID_VALUE } from '../version.js';
import {
  ANNOTATIONS, DESCRIPTION_TAIL, ProvenanceSchema, RESOURCES, blockOf, commonShape, controllerInput, generationOf, header, limitedRead, ok,
  provenance, provenanceLine, refreshed, replaying, scoped,
} from './common.js';
import { findTask } from './moduleRead.js';

export const NAME = 'read_rapid_variable';
export const DESCRIPTION = 'The value of one RAPID data symbol (a VAR, PERS or CONST) in the form the controller gives it, as RAPID text:'
  + ' a num as 0, a record such as a tooldata as one bracketed text, a string with its double quotes. The controller gives no type with it.'
  + ' Each call reaches the controller (the daemon shares an answer for 2 s). Needs abb-rws-daemon 0.1.1 or later.'
  + DESCRIPTION_TAIL;

export const INPUT = {
  controller: controllerInput,
  task: z.string().regex(RAPID_NAME).describe('The RAPID task, e.g. T_ROB1.'),
  module: z.string().regex(RAPID_NAME).describe('The module that declares the symbol, e.g. MainModule.'),
  symbol: z.string().regex(RAPID_NAME).describe('The data symbol, e.g. partPresent.'),
};

/** The longest value kept: the daemon cuts there too. */
export const VALUE_MAX = 16_384;

export const OUTPUT = z.object({
  ...commonShape,
  task: z.string(),
  module: z.string(),
  symbol: z.string(),
  truncated: z.boolean(),
  typed: z.literal(false),
  provenance: ProvenanceSchema,
  controllerData: z.object({ value: z.string() }),
});

interface Args { controller?: string; task: string; module: string; symbol: string }

/** Whether the daemon's schema has the value route: 0.15 or a later minor of the same major. */
function hasValueRoute(version: string): boolean {
  const m = /^([0-9]{1,4})\.([0-9]{1,4})$/.exec(version);
  return m !== null && Number(m[1]) === SCHEMA_RAPID_VALUE.major && Number(m[2]) >= SCHEMA_RAPID_VALUE.minor;
}

export async function readRapidVariable(ctx: Context, args: Args): Promise<ReturnType<typeof ok>> {
  const scope = await scoped(ctx, args.controller);
  // A replaying daemon serves the recording's schema: an old one means an old recording, not an old daemon.
  if (!hasValueRoute(scope.ready.schemaVersion)) {
    throw replaying(scope) ? errors.recordingTooOld(scope.ready.schemaVersion) : errors.daemonTooOld(scope.ready.schemaVersion);
  }

  // The snapshot's lists first: a task or a module it does not list costs no controller read.
  const tasks = scope.snap.rapid.tasks;
  const task = findTask(scope, args.task);
  if (!task && tasks.length > 0) { throw errors.notFound('task', cleanDeep({ tasks: tasks.map(t => t.name) })); }
  let module = args.module;
  if (task && task.modules.length > 0) {
    const listed = task.modules.find(m => m.toLowerCase() === args.module.toLowerCase());
    if (!listed) { throw errors.notFound('module', cleanDeep({ task: task.name, modules: task.modules.slice(0, 200) })); }
    if (RAPID_NAME.test(listed)) { module = listed; }
  }
  const taskName = task && RAPID_NAME.test(task.name) ? task.name : args.task;

  const ans = await limitedRead(ctx, scope.id, () => ctx.daemon.get('symbol', { id: scope.id, task: taskName, module, symbol: args.symbol }));
  if (ans.status !== 200) {
    const body = errorBody(ans.body);
    if (ans.status === 502 && body.code === 'VALUE_NOT_READ') { throw errors.valueNotRead(); }
    // The daemon answers either code for a symbol, module or task the controller does not know.
    if (ans.status === 404 && (body.code === 'RESOURCE_NOT_FOUND' || body.code === 'MODULE_NOT_FOUND')) {
      throw errors.symbolNotFound(body.controller ? cleanDeep({ controller: body.controller }) : undefined);
    }
    if (ans.status === 404 && body.code === 'NOT_RECORDED') { throw errors.notFound('recorded value of that symbol in the replay'); }
    if (ans.status === 404 && body.code === 'NO_ROUTE') { throw errors.daemonTooOld(scope.ready.schemaVersion); }
    throw answerError(ans, scope.ready.ids);
  }
  const read = parseAnswer(RapidSymbolValue, ans.body, 'symbol');
  // KR-1: an empty value is never shown as a value.
  if (read.value === '') { throw errors.valueNotRead(); }

  // This server's time after the read: the value's age is never negative.
  const s = refreshed(ctx, scope);
  const { now } = s;
  const { common, lines: head } = header(s, ['rapid']);
  const cut = read.value.length > VALUE_MAX;
  const value = clean(cut ? read.value.slice(0, VALUE_MAX) : read.value, VALUE_MAX);
  const truncated = read.truncated || cut;
  // The resource must be the template of this controller's generation, word for word; else 'unknown'.
  const gen = generationOf(s.snap);
  const prov = provenance(s, 'controller', gen && read.resource === RESOURCES.symbolValue[gen] ? read.resource : null, read.readAt);

  const out = {
    ...common,
    task: taskName,
    module,
    symbol: args.symbol,
    truncated,
    typed: false as const,
    provenance: prov,
    controllerData: { value },
  };
  const t = [...head];
  t.push(`The value of ${args.symbol} in module ${module} of task ${taskName}, as the controller's RAPID text.`
    + ' The controller gives no type with it, so the type is not shown.'
    + `${truncated ? ' The value was cut at 16,384 characters.' : ''}`);
  t.push(prov.via === 'recording'
    ? `From the recording the daemon replays, read at ${when(prov.readAt, now)}. It is not the robot's value now.`
    : `Read from the controller at ${when(prov.readAt, now)}. It may have changed since.`);
  t.push(provenanceLine(prov));
  const f = fence(value);
  t.push(blockOf(s.nonce, `${f}\n${value}\n${f}`));
  return ok(t.join('\n'), out);
}

export const annotations = ANNOTATIONS;

import { z } from 'zod';
import { cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { RAPID_NAME } from '../daemon.js';
import { errors } from '../errors.js';
import { CYCLE, EXEC_STATE, TASK_STATE, knownValue, meaning } from '../meanings.js';
import { ageS, validTime, when } from '../render.js';
import type { Task } from '../schema.js';
import { ANNOTATIONS, DESCRIPTION_TAIL, commonShape, controllerInput, blockOf, dataText, header, ok, reasons, scoped } from './common.js';

export const NAME = 'get_rapid_execution';
export const DESCRIPTION = 'Execution state and program pointers of the RAPID tasks: running or stopped, the cycle, and where each task is'
  + ' (program pointer and motion pointer: module, routine, line). For the program text, use read_rapid_source.'
  + DESCRIPTION_TAIL;

export const INPUT = {
  controller: controllerInput,
  task: z.string().regex(RAPID_NAME).optional().describe('Only this RAPID task (its name, e.g. T_ROB1).'),
};

export const MODULES_MAX = 200;

const PointerOut = z.object({ module: z.string(), routine: z.string().nullable(), line: z.number().nullable() }).nullable();

export const OUTPUT = z.object({
  ...commonShape,
  execState: z.string().nullable(),
  cycle: z.string().nullable(),
  asOf: z.string().nullable(),
  ageS: z.number().nullable(),
  meanings: z.object({ execState: z.string(), cycle: z.string() }),
  taskCount: z.number(),
  controllerData: z.object({
    tasks: z.array(z.object({
      name: z.string(), type: z.string(), taskState: z.string().nullable(), taskStateMeaning: z.string(),
      execState: z.string().nullable(), active: z.boolean(), motion: z.boolean(), hasMotionPointer: z.boolean(),
      modules: z.array(z.string()), modulesTruncated: z.boolean(), pp: PointerOut, mp: PointerOut,
    })),
    reported: z.object({ execState: z.string().nullable(), cycle: z.string().nullable() }),
    freshnessReasons: z.array(z.string()),
    linkReason: z.string().nullable(),
    groupReasons: z.array(z.object({ group: z.string(), reason: z.string() })),
  }),
});

export function taskOut(t: Task): z.infer<typeof OUTPUT>['controllerData']['tasks'][number] {
  return {
    name: t.name, type: t.type, taskState: t.taskState, taskStateMeaning: meaning(TASK_STATE, t.taskState, true),
    execState: t.execState, active: t.active, motion: t.motion, hasMotionPointer: t.mp !== null,
    modules: t.modules.slice(0, MODULES_MAX), modulesTruncated: t.modules.length > MODULES_MAX,
    pp: t.pp, mp: t.mp,
  };
}

/** One line for a pointer, inside a block: "module MainModule, routine main, line 12". */
function pointerText(p: Task['pp']): string {
  if (!p) { return 'none'; }
  return `module ${JSON.stringify(p.module)}, routine ${p.routine === null ? 'unknown' : JSON.stringify(p.routine)}, line ${p.line ?? 'unknown'}`;
}

export async function getRapidExecution(ctx: Context, args: { controller?: string; task?: string }): Promise<ReturnType<typeof ok>> {
  const s = await scoped(ctx, args.controller);
  const { snap, now } = s;
  const { common, lines } = header(s, ['rapid']);
  const r = snap.rapid;
  let tasks = r.tasks;
  if (args.task !== undefined) {
    const want = args.task.toLowerCase();
    tasks = tasks.filter(t => t.name.toLowerCase() === want);
    if (tasks.length === 0) {
      throw errors.notFound('task', cleanDeep({ tasks: r.tasks.map(t => t.name) }));
    }
  }
  const rs = reasons(snap, ['rapid']);
  const controllerData = cleanDeep({
    tasks: tasks.map(taskOut),
    reported: { execState: r.execState, cycle: r.cycle },
    ...rs,
  });
  const out = {
    ...common,
    execState: knownValue(EXEC_STATE, r.execState),
    cycle: knownValue(CYCLE, r.cycle),
    asOf: validTime(r.asOf),
    ageS: ageS(r.asOf, now),
    meanings: { execState: meaning(EXEC_STATE, r.execState), cycle: meaning(CYCLE, r.cycle) },
    taskCount: tasks.length,
    controllerData,
  };
  const t = [...lines];
  t.push(`RAPID: ${out.execState ? `${out.meanings.execState}` : 'execution state not read yet or not a known value.'} Cycle: ${out.cycle ?? 'not known'} (${out.meanings.cycle}). As of ${when(r.asOf, now)}.`);
  t.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} below. Program pointer = the next instruction to run; motion pointer = the move instruction the robot is on, also while it waits.`
    + ' Line numbers match read_rapid_source.');
  const body = controllerData.tasks.map((task, i) => [
    `task ${i}: ${JSON.stringify(task.name)}, type ${JSON.stringify(task.type)}, state ${task.taskState === null ? 'unknown' : JSON.stringify(task.taskState)},`
      + ` execution ${task.execState ?? 'unknown'}, ${task.active ? 'active' : 'not active'}, ${task.motion ? 'motion task' : 'no motion'}`,
    `  program pointer: ${pointerText(task.pp)}`,
    `  motion pointer: ${pointerText(task.mp)}`,
    `  modules: ${task.modules.length ? task.modules.map(m => JSON.stringify(m)).join(', ') : 'none listed'}${task.modulesTruncated ? ' (cut)' : ''}`,
  ].join('\n')).join('\n');
  const hasReasons = rs.freshnessReasons.length > 0 || rs.linkReason !== null || rs.groupReasons.length > 0;
  t.push(blockOf(s.nonce, body || 'no tasks listed', hasReasons ? dataText(rs, now) : ''));
  return ok(t.join('\n'), out);
}

export const annotations = ANNOTATIONS;

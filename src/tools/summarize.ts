import { z } from 'zod';
import { SOURCE_LINE_MAX, clean, cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { RAPID_NAME, answerError } from '../daemon.js';
import { ToolError } from '../errors.js';
import { COLLISION, CTRL_STATE, CYCLE, EXEC_STATE, OP_MODE, TASK_STATE, knownValue, meaning } from '../meanings.js';
import { ageS, validTime, when } from '../render.js';
import { EventsPage, parseAnswer, type ControllerEvent, type Pointer, type Snapshot } from '../schema.js';
import {
  ANNOTATIONS, DESCRIPTION_TAIL, blockOf, commonShape, controllerInput, dataText, header, ok, reasons, refreshed, scoped, type ReadBudget, type Scoped,
} from './common.js';
import { EventOut, eventOut, eventText, severityOf, windowTime, categoryOf } from './eventsCommon.js';
import { readModule } from './moduleRead.js';

export const NAME = 'summarize_controller';
export const DESCRIPTION = "Start here for 'what is it doing' and 'why did it stop'. One call gives the controller state in one sentence,"
  + ' plain facts from the snapshot, the recent errors and warnings with ABB\'s recommended actions, the operational messages that mark state transitions,'
  + ' and the source line at each program pointer. Served from the daemon\'s memory, plus at most two module reads.'
  + DESCRIPTION_TAIL;

export const INPUT = {
  controller: controllerInput,
  windowMinutes: z.number().int().min(1).max(1440).optional().describe('Errors and warnings of the last this many minutes (default 60).'),
  sourceLine: z.boolean().optional().describe('Read the source line at the program pointers (default true; at most two module reads).'),
};

export const FACT_CODES = [
  'GUARD_STOP', 'EMERGENCY_STOP', 'EMERGENCY_STOP_RESET', 'SYSTEM_FAILURE', 'MOTORS_OFF', 'COLLISION_TRIGGERED',
  'STOPPED_MOTORS_ON', 'MANUAL_MODE', 'SPEED_BELOW_100', 'NO_PROGRAM_POINTER', 'LINK_NOT_CURRENT', 'NO_PROBLEMS_IN_WINDOW',
] as const;
type FactCode = typeof FACT_CODES[number];

const PROBLEMS_MAX = 5;
const TIMELINE_MAX = 5;
const MODULE_READS_MAX = 2;

const PointerOut = z.object({
  module: z.string(), routine: z.string().nullable(), line: z.number().nullable(),
  sourceLine: z.string().nullable(), sourceReadAt: z.string().nullable(),
}).nullable();

export const OUTPUT = z.object({
  ...commonShape,
  state: z.string(),
  facts: z.array(z.object({ code: z.enum(FACT_CODES), text: z.string(), task: z.number().optional() })),
  meanings: z.object({
    ctrlState: z.string(), opMode: z.string(), collisionDetection: z.string(), execState: z.string(), cycle: z.string(),
    tasks: z.array(z.object({ task: z.number(), execState: z.string(), taskState: z.string() })),
  }),
  windowMinutes: z.number(),
  olderProblems: z.number(),
  notes: z.array(z.string()),
  controllerData: z.object({
    panel: z.object({
      ctrlState: z.string().nullable(), opMode: z.string().nullable(), speedRatio: z.number().nullable(),
      collisionDetection: z.string().nullable(), asOf: z.string().nullable(), ageS: z.number().nullable(),
    }),
    tasks: z.array(z.object({
      name: z.string(), type: z.string(), execState: z.string().nullable(), active: z.boolean(), motion: z.boolean(),
      hasMotionPointer: z.boolean(), pp: PointerOut, mp: PointerOut,
    })),
    problems: z.array(EventOut),
    timeline: z.array(EventOut),
    freshnessReasons: z.array(z.string()),
    linkReason: z.string().nullable(),
    groupReasons: z.array(z.object({ group: z.string(), reason: z.string() })),
  }),
});

type Fact = { code: FactCode; text: string; task?: number };

/** One sentence from fixed fragments and known enum values; never a name. */
export function stateSentence(snap: Snapshot): string {
  const c = snap.panel.ctrlState;
  const ctrl: Record<string, string> = {
    motoron: 'Motors on', motoroff: 'Motors off', guardstop: 'Guard stop', emergencystop: 'Emergency stop',
    emergencystopreset: 'Emergency stop reset', sysfail: 'System failure', init: 'Controller starting up',
  };
  const mode: Record<string, string> = { AUTO: 'automatic mode', MANR: 'manual mode, reduced speed', MANF: 'manual mode, full speed' };
  const a = c === null ? 'Controller state not read yet' : ctrl[c] ?? 'Controller state not a known value';
  const o = snap.panel.opMode;
  const b = o === null ? 'operating mode not read yet' : mode[o] ?? 'operating mode not a known value';
  const e = snap.rapid.execState;
  const x = e === 'running' ? 'program running' : e === 'stopped' ? 'program stopped' : e === null ? 'program state not read yet' : 'program state not a known value';
  return `${a}, ${b}, ${x}.`;
}

export function factsOf(snap: Snapshot): Fact[] {
  const f: Fact[] = [];
  const p = snap.panel;
  switch (p.ctrlState) {
    case 'guardstop': f.push({ code: 'GUARD_STOP', text: 'A guard stop is active: a safety circuit is open.' }); break;
    case 'emergencystop': f.push({ code: 'EMERGENCY_STOP', text: 'An emergency stop is active.' }); break;
    case 'emergencystopreset': f.push({ code: 'EMERGENCY_STOP_RESET', text: 'The emergency stop was reset; leaving that state is not confirmed yet.' }); break;
    case 'sysfail': f.push({ code: 'SYSTEM_FAILURE', text: 'The controller is in system failure.' }); break;
    case 'motoroff': f.push({ code: 'MOTORS_OFF', text: 'Motors are off.' }); break;
    default: break;
  }
  if (p.collisionDetection === 'TRIGGERED') { f.push({ code: 'COLLISION_TRIGGERED', text: 'Collision detection has triggered.' }); }
  if (snap.rapid.execState === 'stopped' && p.ctrlState === 'motoron') {
    f.push({ code: 'STOPPED_MOTORS_ON', text: 'The program is stopped while the motors are on.' });
  }
  if (p.opMode === 'MANR' || p.opMode === 'MANF') { f.push({ code: 'MANUAL_MODE', text: `The controller is in manual mode (${p.opMode}).` }); }
  if (typeof p.speedRatio === 'number' && Number.isFinite(p.speedRatio) && p.speedRatio < 100) {
    f.push({ code: 'SPEED_BELOW_100', text: `The speed override is ${p.speedRatio} %.` });
  }
  snap.rapid.tasks.forEach((t, i) => {
    if (t.active && t.pp === null) { f.push({ code: 'NO_PROGRAM_POINTER', text: 'An active task has no program pointer (no program loaded, or not read yet).', task: i }); }
  });
  if (snap.freshness.level !== 'current') { f.push({ code: 'LINK_NOT_CURRENT', text: 'The controller data is not current: see the status line.' }); }
  return f;
}

/** Pointers whose source line is wanted, in order: stopped tasks' pp, other motion tasks' pp, then mp modules that differ. */
function pointerOrder(snap: Snapshot): { task: number; which: 'pp' | 'mp' }[] {
  const order: { task: number; which: 'pp' | 'mp' }[] = [];
  const tasks = snap.rapid.tasks;
  tasks.forEach((t, i) => { if (t.pp && t.execState === 'stopped') { order.push({ task: i, which: 'pp' }); } });
  tasks.forEach((t, i) => { if (t.pp && t.motion && t.execState !== 'stopped') { order.push({ task: i, which: 'pp' }); } });
  tasks.forEach((t, i) => { if (t.pp && !t.motion && t.execState !== 'stopped') { order.push({ task: i, which: 'pp' }); } });
  tasks.forEach((t, i) => { if (t.mp && t.mp.module !== t.pp?.module) { order.push({ task: i, which: 'mp' }); } });
  return order;
}

interface Line { sourceLine: string | null; sourceReadAt: string | null }

/** Failed reads after which the next module is still read: they concern one module, not the link or the budget. */
const READ_ON_AFTER = new Set(['NOT_FOUND', 'CONTROLLER_ERROR']);

/**
 * The source lines at the pointers, from at most MODULE_READS_MAX requests to
 * the daemon. Every request sent counts, a failed one and a retry included; a
 * cache hit, or a read refused before sending (a module the snapshot does not
 * list, this server's own BUSY), does not. After a failure that is not about
 * one module (the controller unavailable, the daemon not answering, BUSY), no
 * further module is read.
 */
async function sourceLines(ctx: Context, s: Scoped, notes: string[]): Promise<Map<string, Line>> {
  const got = new Map<string, Line>();
  const modules = new Map<string, { text: string[]; readAt: string } | null>();
  const budget: ReadBudget = { left: MODULE_READS_MAX };
  let stopped = false;
  let skipped = false;
  for (const { task, which } of pointerOrder(s.snap)) {
    const t = s.snap.rapid.tasks[task];
    const ptr = t[which] as Pointer;
    if (ptr.line === null || !RAPID_NAME.test(t.name) || !RAPID_NAME.test(ptr.module)) { continue; }
    const key = `${t.name}\u0000${ptr.module}`.toLowerCase();
    if (!modules.has(key)) {
      if (stopped || budget.left <= 0) { skipped = true; continue; }
      try {
        const m = await readModule(ctx, s, t.name, ptr.module, budget);
        modules.set(key, { text: m.text.split('\n'), readAt: new Date(m.readAt).toISOString() });
      } catch (e) {
        if (!(e instanceof ToolError)) { throw e; }
        modules.set(key, null);
        notes.push(e.code === 'BUSY'
          ? `A source line was not read: the read budget was in use (BUSY). Read it with read_rapid_source in a few seconds.`
          : `A source line was not read (${e.code}).`);
        if (!READ_ON_AFTER.has(e.code)) { stopped = true; }
      }
    }
    const m = modules.get(key);
    if (m && ptr.line >= 1 && ptr.line <= m.text.length) {
      got.set(`${task}:${which}`, { sourceLine: clean(m.text[ptr.line - 1], SOURCE_LINE_MAX), sourceReadAt: m.readAt });
    }
  }
  if (skipped) {
    notes.push(stopped
      ? 'The other source lines were not read after that failure.'
      : `The other source lines were not read: this tool makes at most ${MODULE_READS_MAX} module reads per call. read_rapid_source reads them.`);
  }
  return got;
}

function problemsIn(events: ControllerEvent[], from: number): { problems: ControllerEvent[]; older: number } {
  const newestFirst = [...events].sort((a, b) => b.seq - a.seq);
  const pick = (sev: 'error' | 'warning'): ControllerEvent[] => {
    const all = newestFirst.filter(e => severityOf(e) === sev);
    const out: ControllerEvent[] = [];
    for (const [i, e] of all.entries()) {
      const t = windowTime(e);
      // An event of unknown time is listed when it is among the newest, never dropped silently.
      if ((t !== null && t >= from) || (t === null && i < PROBLEMS_MAX)) { out.push(e); }
      if (out.length >= PROBLEMS_MAX) { break; }
    }
    return out;
  };
  const problems = [...pick('error'), ...pick('warning')].sort((a, b) => b.seq - a.seq);
  const older = newestFirst.filter(e => {
    const sev = severityOf(e);
    const t = windowTime(e);
    return (sev === 'error' || sev === 'warning') && t !== null && t < from;
  }).length;
  return { problems, older };
}

export async function summarizeController(ctx: Context, args: { controller?: string; windowMinutes?: number; sourceLine?: boolean }): Promise<ReturnType<typeof ok>> {
  const scope = await scoped(ctx, args.controller);
  const ans = await ctx.daemon.get('events', { id: scope.id }, { limit: 256 });
  if (ans.status !== 200) { throw answerError(ans, scope.ready.ids); }
  const page = parseAnswer(EventsPage, ans.body, 'events');
  const notes: string[] = [];
  const lines = args.sourceLine === false ? new Map<string, Line>() : await sourceLines(ctx, scope, notes);

  // This server's time after the last read: a module read can take seconds.
  const s = refreshed(ctx, scope);
  const { snap, now } = s;
  const { common, lines: head } = header(s, ['panel', 'rapid', 'events']);
  const windowMinutes = args.windowMinutes ?? 60;
  const from = now - windowMinutes * 60_000;
  const { problems, older } = problemsIn(page.events, from);
  const timeline = [...page.events].sort((a, b) => b.seq - a.seq).filter(e => categoryOf(e.code) === 'operational').slice(0, TIMELINE_MAX);

  const facts = factsOf(snap);
  if (problems.length === 0) { facts.push({ code: 'NO_PROBLEMS_IN_WINDOW', text: `No error or warning in the last ${windowMinutes} min.` }); }

  const ptrOut = (task: number, which: 'pp' | 'mp', p: Pointer | null): z.infer<typeof PointerOut> => {
    if (!p) { return null; }
    const l = lines.get(`${task}:${which}`);
    return { module: p.module, routine: p.routine, line: p.line, sourceLine: l?.sourceLine ?? null, sourceReadAt: l?.sourceReadAt ?? null };
  };

  const rs = reasons(snap, ['panel', 'rapid', 'events']);
  const problemsOut = problems.map(e => eventOut(e, now, 'summary'));
  const timelineOut = timeline.map(e => eventOut(e, now, 'summary'));
  const controllerData = cleanDeep({
    panel: {
      ctrlState: snap.panel.ctrlState, opMode: snap.panel.opMode, speedRatio: snap.panel.speedRatio,
      collisionDetection: snap.panel.collisionDetection, asOf: validTime(snap.panel.asOf), ageS: ageS(snap.panel.asOf, now),
    },
    tasks: snap.rapid.tasks.map((t, i) => ({
      name: t.name, type: t.type, execState: t.execState, active: t.active, motion: t.motion, hasMotionPointer: t.mp !== null,
      pp: ptrOut(i, 'pp', t.pp), mp: ptrOut(i, 'mp', t.mp),
    })),
    problems: problemsOut,
    timeline: timelineOut,
    ...rs,
  });

  const out = {
    ...common,
    state: stateSentence(snap),
    facts,
    meanings: {
      ctrlState: meaning(CTRL_STATE, snap.panel.ctrlState),
      opMode: meaning(OP_MODE, snap.panel.opMode),
      collisionDetection: meaning(COLLISION, snap.panel.collisionDetection),
      execState: meaning(EXEC_STATE, snap.rapid.execState),
      cycle: meaning(CYCLE, snap.rapid.cycle),
      tasks: snap.rapid.tasks.map((t, i) => ({ task: i, execState: meaning(EXEC_STATE, t.execState), taskState: meaning(TASK_STATE, t.taskState, true) })),
    },
    windowMinutes,
    olderProblems: older,
    notes,
    controllerData,
  };

  const t = [...head];
  t.push(`State: ${out.state}`);
  const ctrlKnown = knownValue(CTRL_STATE, snap.panel.ctrlState);
  if (ctrlKnown) { t.push(`Controller state ${ctrlKnown}: ${out.meanings.ctrlState}`); }
  t.push(`Panel values as of ${when(snap.panel.asOf, now)}; RAPID as of ${when(snap.rapid.asOf, now)}.`);
  t.push('Facts (from the snapshot, not inferred):');
  for (const f of facts) { t.push(`- ${f.code}: ${f.text}${f.task !== undefined ? ` (task ${f.task} in the block)` : ''}`); }
  t.push(`Errors and warnings in the last ${windowMinutes} min: ${problems.length}${older ? `; ${older} older ones are in the daemon's log (get_event_log)` : ''}.`);
  t.push(`State-change messages (operational events), newest first: ${timeline.length}. Until the daemon serves a change time, these are the only evidence for when the state changed.`);
  t.push('A motion pointer means a task runs a move or waits in one; it does not mean the arm moves. get_robot_position says whether it moves.');
  t.push('Problem descriptions are cut to their first sentence; get_event_log with detail full gives the whole text.');
  for (const n of notes) { t.push(n); }

  const taskText = controllerData.tasks.map((task, i) => {
    const ptr = (label: string, p: z.infer<typeof PointerOut>): string => (p
      ? `  ${label}: module ${JSON.stringify(p.module)}, routine ${p.routine === null ? 'unknown' : JSON.stringify(p.routine)}, line ${p.line ?? 'unknown'}`
        + `${p.sourceLine !== null ? `\n    source: ${p.sourceLine.trim()}` : ''}`
      : `  ${label}: none`);
    return [`task ${i}: ${JSON.stringify(task.name)}, ${task.execState ?? 'execution state unknown'}, ${task.active ? 'active' : 'not active'}, ${task.motion ? 'motion task' : 'no motion'}`,
      ptr('program pointer', task.pp), ptr('motion pointer', task.mp)].join('\n');
  }).join('\n');
  const reported = `panel as reported: ctrlState ${JSON.stringify(controllerData.panel.ctrlState)}, opMode ${JSON.stringify(controllerData.panel.opMode)},`
    + ` speed ${controllerData.panel.speedRatio ?? 'unknown'} %, collision detection ${JSON.stringify(controllerData.panel.collisionDetection)}`;
  const probText = problemsOut.length ? `problems (newest first):\n${problemsOut.map((e, i) => eventText(e, problems[i], now)).join('\n')}` : 'problems: none in the window';
  const tlText = timelineOut.length ? `state changes (newest first):\n${timelineOut.map((e, i) => eventText(e, timeline[i], now)).join('\n')}` : 'state changes: none recorded';
  const hasReasons = rs.freshnessReasons.length > 0 || rs.linkReason !== null || rs.groupReasons.length > 0;
  t.push(blockOf(s.nonce, reported, taskText || 'no tasks listed', probText, tlText, hasReasons ? dataText(rs, now) : ''));
  return ok(t.join('\n'), out);
}

export const annotations = ANNOTATIONS;

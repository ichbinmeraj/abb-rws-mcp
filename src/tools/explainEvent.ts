import { z } from 'zod';
import { SOURCE_LINE_MAX, clean, cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { RAPID_NAME, answerError } from '../daemon.js';
import { ToolError, errors } from '../errors.js';
import { ageS, when } from '../render.js';
import { EventsPage, parseAnswer, type ControllerEvent, type Task } from '../schema.js';
import {
  ANNOTATIONS, DESCRIPTION_TAIL, ProvenanceSchema, RESOURCES, blockOf, commonShape, controllerInput, generationOf, header,
  ok, provenance, provenanceLine, refreshed, replaying, scoped, type Scoped,
} from './common.js';
import { ARGS_SHOWN, EventOut, categoryOf, eventOut, eventText, eventWhen, markedBy, severityOf, timeNotes, windowTime, type Severity } from './eventsCommon.js';
import { readModule } from './moduleRead.js';

export const NAME = 'explain_event';
export const DESCRIPTION = 'One event of the controller\'s log, laid out for explaining it: what the controller says (ABB\'s description, causes,'
  + ' consequences and actions), kept apart from our reading of it (the category from ABB\'s numbering, the severity, the time and,'
  + ' when the event names one, the RAPID line), and the events just before and after it. It does not say what caused the event:'
  + ' the data does not show that. Name the event by seq together with its feed (both from get_event_log or summarize_controller),'
  + ' or by code (the newest event with that code).'
  + ' Served from the daemon\'s memory; one module read when the event names a RAPID line.'
  + DESCRIPTION_TAIL;

const FEED = /^[A-Za-z0-9_-]{1,64}$/;

export const INPUT = {
  controller: controllerInput,
  seq: z.number().int().min(0).optional().describe('The event\'s seq, from get_event_log or summarize_controller. Needs feed.'),
  code: z.number().int().min(0).optional().describe('The event code: the newest event with this code. With seq, it must be that event\'s code.'),
  feed: z.string().regex(FEED).optional().describe('The feed the seq belongs to, from the same answer as the seq. Needed with seq; refused when the numbering started over.'),
  aroundS: z.number().int().min(1).max(600).optional().describe('Seconds before and after the event to list other events (default 60).'),
};

export const AROUND_DEFAULT_S = 60;
/** The most events listed on each side of the event. */
export const AROUND_SIDE_MAX = 20;
/** Without a time, the events listed on each side, by seq. */
export const AROUND_BY_SEQ = 5;

/** A program reference in an event's args: /module/routine[/instruction]/line (as RW 6, 7 and 8 logs carry it). */
const PROGRAM_REF = /^\/([A-Za-z][A-Za-z0-9_]{0,31})\/([A-Za-z][A-Za-z0-9_]{0,31})(?:\/[A-Za-z][A-Za-z0-9_]{0,31})*\/([0-9]{1,6})$/;

export const NOT_SHOWN = 'The data does not show the cause. These are the events around it.';

const SEVERITY_MEANING: Record<Severity, string> = {
  error: 'The controller logged it as an error.',
  warning: 'The controller logged it as a warning.',
  info: 'The controller logged it as information.',
  other: 'The controller gave no severity this server knows.',
};

const AroundOut = z.object({
  seq: z.number(),
  code: z.number().nullable(),
  severity: z.enum(['info', 'warning', 'error', 'other']),
  title: z.string(),
  at: z.string().nullable(),
  marked: z.boolean().nullable(),
});

const RapidLineOut = z.object({
  task: z.string(),
  /** 'event': an arg of the event names the task. 'inferred': no arg does, and this is the one task that lists the module. */
  taskFrom: z.enum(['event', 'inferred']),
  module: z.string(),
  routine: z.string(),
  line: z.number(),
  read: z.boolean(),
  /** Where the module text came from; null when it was not read. */
  via: z.enum(['controller', 'cache', 'recording']).nullable(),
  resource: z.string(),
  changeCount: z.number().nullable(),
  readAt: z.string().nullable(),
  problem: z.string().nullable(),
});

export const OUTPUT = z.object({
  ...commonShape,
  feed: z.string().nullable(),
  seq: z.number(),
  code: z.number().nullable(),
  marked: z.boolean().nullable(),
  ourReading: z.object({
    category: z.string().nullable(),
    severity: z.enum(['info', 'warning', 'error', 'other']),
    severityMeaning: z.string(),
    at: z.string().nullable(),
    ageS: z.number().nullable(),
    timeNotes: z.array(z.string()),
    backlog: z.boolean(),
    rapidLine: RapidLineOut.nullable(),
  }),
  around: z.object({ by: z.enum(['time', 'seq']), windowS: z.number().nullable(), before: z.number(), after: z.number() }),
  notShown: z.string(),
  provenance: ProvenanceSchema,
  controllerData: z.object({
    controllerSays: EventOut,
    rapidLineText: z.string().nullable(),
    around: z.array(AroundOut),
  }),
});

interface Args { controller?: string; seq?: number; code?: number; feed?: string; aroundS?: number }

type RapidLine = z.infer<typeof RapidLineOut>;

/**
 * The task a program reference belongs to. When an arg names a task, that task only, and none when it
 * does not list the module; when no arg names one, the one task that lists the module (inferred).
 */
function taskOf(tasks: readonly Task[], args: ControllerEvent['args'], module: string): { task: Task; from: 'event' | 'inferred' } | null {
  const lists = (t: Task): boolean => t.modules.some(m => m.toLowerCase() === module.toLowerCase());
  const named = tasks.find(t => args.some(a => a.value.trim().toLowerCase() === t.name.toLowerCase()));
  if (named) { return lists(named) ? { task: named, from: 'event' } : null; }
  const listing = tasks.filter(lists);
  return listing.length === 1 ? { task: listing[0], from: 'inferred' } : null;
}

/** The RAPID line the event names in the args an answer shows, and that line as the module reads now (one module read). */
async function rapidLineOf(ctx: Context, s: Scoped, e: ControllerEvent): Promise<{ line: RapidLine; text: string | null } | null> {
  const shown = e.args.slice(0, ARGS_SHOWN);
  const gen = generationOf(s.snap);
  const resource = gen ? RESOURCES.moduleText[gen] : 'unknown';
  for (const arg of shown) {
    const m = PROGRAM_REF.exec(arg.value.trim());
    if (!m) { continue; }
    const found = taskOf(s.snap.rapid.tasks, shown, m[1]);
    if (!found || !RAPID_NAME.test(found.task.name)) { continue; }
    const line: RapidLine = {
      task: found.task.name, taskFrom: found.from, module: m[1], routine: m[2], line: Number(m[3]),
      read: false, via: null, resource, changeCount: null, readAt: null, problem: null,
    };
    try {
      const mod = await readModule(ctx, s, found.task.name, m[1]);
      const lines = mod.text.split('\n');
      const text = line.line >= 1 && line.line <= lines.length ? clean(lines[line.line - 1], SOURCE_LINE_MAX) : null;
      const replay = replaying(s);
      return {
        line: {
          ...line, module: mod.module, read: true, via: replay ? 'recording' : mod.fromCache ? 'cache' : 'controller',
          changeCount: mod.changeCount,
          // In a replay the module's time is when this server got it, not when it was recorded: none is given.
          readAt: replay ? null : new Date(mod.readAt).toISOString(),
          problem: text === null ? 'LINE_NOT_IN_MODULE' : null,
        },
        text,
      };
    } catch (err) {
      if (!(err instanceof ToolError)) { throw err; }
      return { line: { ...line, problem: err.code }, text: null };
    }
  }
  return null;
}

export async function explainEvent(ctx: Context, args: Args): Promise<ReturnType<typeof ok>> {
  if (args.seq === undefined && args.code === undefined) {
    throw new ToolError('NOT_FOUND', 'No event named. Give seq with its feed (from get_event_log), or code.');
  }
  // KR-1: a seq means one event only within its feed (the daemon numbers anew after a restart).
  if (args.seq !== undefined && args.feed === undefined) { throw errors.feedNeeded(); }
  const scope = await scoped(ctx, args.controller);
  const ans = await ctx.daemon.get('events', { id: scope.id }, { limit: 256 });
  if (ans.status !== 200) { throw answerError(ans, scope.ready.ids); }
  const page = parseAnswer(EventsPage, ans.body, 'events');
  if (args.seq !== undefined && (!FEED.test(page.feed) || args.feed !== page.feed)) { throw errors.feedChanged(); }

  const byCode = args.code;
  const target = args.seq !== undefined
    ? page.events.find(e => e.seq === args.seq)
    : page.events.filter(e => e.code === byCode).sort((a, b) => b.seq - a.seq)[0];
  if (!target) {
    throw errors.notFound(args.seq !== undefined ? 'event with that seq' : 'event with that code', {
      feed: FEED.test(page.feed) ? page.feed : null, firstSeq: page.firstSeq, lastSeq: page.lastSeq, held: page.events.length,
    });
  }
  if (args.seq !== undefined && byCode !== undefined && target.code !== byCode) {
    throw new ToolError('NOT_FOUND', `Event seq ${target.seq} has code ${target.code ?? 'none'}, not ${byCode}. Give the seq or the code, or both of one event.`);
  }

  const rapid = await rapidLineOf(ctx, scope, target);
  // This server's time after the last read.
  const s = refreshed(ctx, scope);
  const { snap, now } = s;
  const { common, lines: head } = header(s, ['events']);
  const marks = ctx.config.markCodes ?? null;

  // The events around it: by time when the event has one, else by seq.
  const windowS = args.aroundS ?? AROUND_DEFAULT_S;
  const t0 = windowTime(target);
  const others = page.events.filter(e => e.seq !== target.seq).sort((a, b) => a.seq - b.seq);
  let before: ControllerEvent[];
  let after: ControllerEvent[];
  if (t0 !== null) {
    const near = (e: ControllerEvent): boolean => {
      const t = windowTime(e);
      return t !== null && Math.abs(t - t0) <= windowS * 1000;
    };
    before = others.filter(e => e.seq < target.seq && near(e)).slice(-AROUND_SIDE_MAX);
    after = others.filter(e => e.seq > target.seq && near(e)).slice(0, AROUND_SIDE_MAX);
  } else {
    before = others.filter(e => e.seq < target.seq).slice(-AROUND_BY_SEQ);
    after = others.filter(e => e.seq > target.seq).slice(0, AROUND_BY_SEQ);
  }
  const aroundOut = [...before, ...after].map(e => {
    const o = eventOut(e, now, 'summary', marks);
    return { seq: o.seq, code: o.code, severity: o.severity, title: o.title, at: o.at, marked: o.marked };
  });

  const says = eventOut(target, now, 'full', marks);
  const sev = severityOf(target);
  // Our reading gives a time only when the daemon corrected it to UTC; the controller's own clock stays in timeNotes.
  const at = target.time.corrected ? says.at : null;
  const gen = generationOf(snap);
  const prov = provenance(s, 'snapshot', gen ? RESOURCES.eventLog[gen] : null, snap.events.asOf);

  const out = {
    ...common,
    feed: FEED.test(page.feed) ? page.feed : null,
    seq: target.seq,
    code: target.code,
    marked: markedBy(marks, target.code),
    ourReading: {
      category: categoryOf(target.code),
      severity: sev,
      severityMeaning: SEVERITY_MEANING[sev],
      at,
      ageS: target.time.corrected ? ageS(target.time.utc, now) : null,
      timeNotes: timeNotes(target),
      backlog: target.backlog,
      rapidLine: rapid?.line ?? null,
    },
    around: { by: t0 !== null ? 'time' as const : 'seq' as const, windowS: t0 !== null ? windowS : null, before: before.length, after: after.length },
    notShown: NOT_SHOWN,
    provenance: prov,
    controllerData: cleanDeep({ controllerSays: says, rapidLineText: rapid?.text ?? null, around: aroundOut }),
  };

  const t = [...head];
  t.push(`Event seq ${target.seq}, code ${target.code ?? 'none'}${out.marked ? ' (MARKED: its code is in the mark-codes list)' : ''}.`
    + ' What the controller says about it is in the block, under "The controller says".');
  const reading = [
    out.ourReading.category ? `category ${out.ourReading.category} (from ABB's event numbering)` : 'no category from its code',
    SEVERITY_MEANING[sev].replace(/\.$/, '').replace(/^The/, 'the'),
    `at ${eventWhen(target, now)}`,
  ];
  t.push(`Our reading, kept apart from the controller's text: ${reading.join('; ')}.`);
  if (rapid) {
    const r = rapid.line;
    const where = r.taskFrom === 'event'
      ? `in task ${r.task}, which the event names`
      : `in task ${r.task} (inferred: no arg of the event is a task of this controller, and ${r.task} is the one task that lists the module)`;
    const from = r.via === 'recording' ? 'from the recording the daemon replays'
      : `${r.via === 'cache' ? "from this server's cache" : 'from the controller'}, read at ${when(r.readAt, now)}`;
    t.push(r.read
      ? `The event names line ${r.line} of module ${r.module} (routine ${r.routine}) ${where}.`
        + `${rapid.text !== null ? ` That line, as the module reads ${from}, is in the block.` : ` The module, ${from}, has no such line.`}`
        + ` The module may have changed since the event (change count ${r.changeCount ?? 'not reported'}).`
      : `The event names line ${r.line} of module ${r.module} (routine ${r.routine}) ${where}. The module could not be read (${r.problem}).`);
  }
  t.push(t0 !== null
    ? `Around it: ${before.length} events before and ${after.length} after, within ${windowS} s (at most ${AROUND_SIDE_MAX} on each side).`
    : `Around it: the event's time is not known, so the ${before.length} events before and ${after.length} after by seq.`);
  t.push(NOT_SHOWN);
  t.push(provenanceLine(prov));

  const parts = [`The controller says:\n${eventText(says, target, now)}`];
  if (rapid && rapid.text !== null) { parts.push(`Line ${rapid.line.line} of ${rapid.line.module} now:\n  ${JSON.stringify(rapid.text)}`); }
  const aroundLine = (e: ControllerEvent): string => {
    const o = eventOut(e, now, 'summary', marks);
    return `- seq ${o.seq}, ${o.severity}, code ${o.code ?? 'none'}${o.marked ? ', MARKED' : ''}: ${JSON.stringify(o.title)} at ${eventWhen(e, now)}`;
  };
  if (before.length || after.length) {
    parts.push(['Events around it:', ...before.map(aroundLine), `- (seq ${target.seq}, the event)`, ...after.map(aroundLine)].join('\n'));
  }
  t.push(blockOf(s.nonce, ...parts));
  return ok(t.join('\n'), out);
}

export const annotations = ANNOTATIONS;

import { z } from 'zod';
import { SOURCE_LINE_MAX, clean, cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { RAPID_NAME } from '../daemon.js';
import { errors } from '../errors.js';
import { ageS, fence, when } from '../render.js';
import {
  ANNOTATIONS, DESCRIPTION_TAIL, ProvenanceSchema, RESOURCES, blockOf, commonShape, controllerInput, generationOf, header, ok,
  provenance, provenanceLine, refreshed, replaying, scoped,
} from './common.js';
import { declaredRoutines, readModule } from './moduleRead.js';

export const NAME = 'read_rapid_source';
export const DESCRIPTION = 'The RAPID source of one module, with line numbers: a whole routine, the lines around a line (such as the program pointer),'
  + ' or a page. Line numbers match the pointers of get_rapid_execution. The first read of a module reaches the controller;'
  + ' the text is then kept here for 60 s.'
  + DESCRIPTION_TAIL;

export const INPUT = {
  controller: controllerInput,
  task: z.string().regex(RAPID_NAME).describe('The RAPID task, e.g. T_ROB1.'),
  module: z.string().regex(RAPID_NAME).describe('The module name, e.g. MainModule.'),
  routine: z.string().regex(RAPID_NAME).optional().describe('Return this PROC, FUNC or TRAP, from its first line to its END line. Wins over aroundLine and fromLine.'),
  aroundLine: z.number().int().min(1).optional().describe('Return the lines around this line. Wins over fromLine.'),
  context: z.number().int().min(0).max(50).optional().describe('Lines before and after aroundLine (default 10).'),
  fromLine: z.number().int().min(1).optional().describe('First line of a page (default 1).'),
  maxLines: z.number().int().min(1).max(1000).optional().describe('Lines in a page (default 150).'),
};

export const LINES_MAX = 1000;
export const ANSWER_BYTES_MAX = 32 * 1024;

export const OUTPUT = z.object({
  ...commonShape,
  task: z.string(),
  module: z.string(),
  kind: z.enum(['program', 'system']).nullable(),
  changeCount: z.number().nullable(),
  totalLines: z.number(),
  fromLine: z.number(),
  toLine: z.number(),
  truncated: z.boolean(),
  readAt: z.string(),
  ageS: z.number(),
  fromCache: z.boolean(),
  provenance: ProvenanceSchema,
  controllerData: z.object({ text: z.string() }),
});

interface Args {
  controller?: string; task: string; module: string; routine?: string;
  aroundLine?: number; context?: number; fromLine?: number; maxLines?: number;
}

export async function readRapidSource(ctx: Context, args: Args): Promise<ReturnType<typeof ok>> {
  const scope = await scoped(ctx, args.controller);
  const mod = await readModule(ctx, scope, args.task, args.module);
  // This server's time after the read, which can take seconds: the text's age is never negative.
  const s = refreshed(ctx, scope);
  const { now } = s;
  const { common, lines: head } = header(s, ['rapid']);
  const all = mod.text.split('\n');
  if (all.length > 0 && all[all.length - 1] === '' && mod.text.endsWith('\n')) { all.pop(); }
  const total = all.length;

  let from: number;
  let to: number;
  let what: string;
  if (args.routine !== undefined) {
    const routines = declaredRoutines(all);
    const r = routines.find(x => x.name.toLowerCase() === args.routine!.toLowerCase());
    if (!r) { throw errors.notFound('routine', cleanDeep({ module: args.module, routines: routines.map(x => x.name).slice(0, 500) })); }
    from = r.start;
    to = r.end ?? total;
    what = `the routine ${args.routine}${r.end === null ? ' (no END line found; to the end of the module)' : ''}`;
  } else if (args.aroundLine !== undefined) {
    const c = args.context ?? 10;
    from = Math.max(1, args.aroundLine - c);
    to = Math.min(total, args.aroundLine + c);
    what = `the lines around line ${args.aroundLine}`;
  } else {
    from = args.fromLine ?? 1;
    to = Math.min(total, from + (args.maxLines ?? 150) - 1);
    what = `lines from ${from}`;
  }

  // Cut to 1,000 lines and 32 KiB; a line over 2,000 characters is cut and marked.
  let truncated = false;
  if (to - from + 1 > LINES_MAX) { to = from + LINES_MAX - 1; truncated = true; }
  const slice: string[] = [];
  let bytes = 0;
  for (let n = from; n <= to && n <= total; n++) {
    const line = clean(all[n - 1], SOURCE_LINE_MAX);
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > ANSWER_BYTES_MAX) { truncated = true; to = n - 1; break; }
    bytes += size;
    slice.push(line);
  }
  if (from > total) { to = from - 1; }
  else { to = Math.min(to, total); }
  const text = slice.join('\n');
  const readAtIso = new Date(mod.readAt).toISOString();
  const gen = generationOf(s.snap);
  // In a replay, readAt is when this server got the text from the daemon, not when it was recorded: none is given.
  const prov = provenance(s, mod.fromCache ? 'cache' : 'controller', gen ? RESOURCES.moduleText[gen] : null, replaying(s) ? null : readAtIso);

  const out = {
    ...common,
    task: args.task,
    module: args.module,
    kind: mod.kind === 'program' || mod.kind === 'system' ? mod.kind : null,
    changeCount: mod.changeCount,
    totalLines: total,
    fromLine: from,
    toLine: to,
    truncated,
    readAt: readAtIso,
    ageS: ageS(readAtIso, now) ?? 0,
    fromCache: mod.fromCache,
    provenance: prov,
    controllerData: { text },
  };

  const t = [...head];
  t.push(`Module ${args.module} of task ${args.task}: ${what}. ${slice.length === 0 ? `No lines in that range; the module has ${total} lines.` : `Lines ${from} to ${to} of ${total}.`}`
    + `${truncated ? ' The answer was cut (at most 1,000 lines and 32 KiB per answer); ask for the next page.' : ''}`);
  t.push(`The text was read at ${when(readAtIso, now)}${mod.fromCache ? ', from this server\'s 60 s cache' : ''}. The module may have changed since;`
    + ` a later read with a different change count (now ${mod.changeCount ?? 'not reported'}) means it did. Line numbers match get_rapid_execution.`);
  t.push(provenanceLine(prov));
  const width = String(Math.max(to, 1)).length;
  const numbered = slice.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n');
  const f = fence(numbered);
  t.push(blockOf(s.nonce, slice.length ? `${f}rapid\n${numbered}\n${f}` : 'no lines'));
  return ok(t.join('\n'), out);
}

export const annotations = ANNOTATIONS;

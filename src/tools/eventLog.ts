import { z } from 'zod';
import { cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { answerError } from '../daemon.js';
import { CODE_PATTERN } from '../errors.js';
import { ageS, known, validTime, when } from '../render.js';
import { EventsPage, parseAnswer } from '../schema.js';
import { ANNOTATIONS, DESCRIPTION_TAIL, blockOf, commonShape, controllerInput, dataText, header, ok, reasons, refreshed, scoped } from './common.js';
import { CATEGORY_NAMES, EventOut, categoryOf, eventOut, eventText, passes, severityOf, windowTime } from './eventsCommon.js';

export const NAME = 'get_event_log';
export const DESCRIPTION = "The controller's event log as the daemon keeps it (the last 256 messages): newest first, warnings and errors by default,"
  + ' with ABB\'s description and recommended actions. Times are corrected to UTC to about a second, or marked when they are not.'
  + ' Served from the daemon\'s memory: no controller request.'
  + DESCRIPTION_TAIL;

const FEED = /^[A-Za-z0-9_-]{1,64}$/;

export const INPUT = {
  controller: controllerInput,
  limit: z.number().int().min(1).max(100).optional().describe('At most this many events (default 20).'),
  minSeverity: z.enum(['info', 'warning', 'error']).optional().describe('The lowest severity returned (default warning). Events without a severity always pass.'),
  sinceMinutes: z.number().int().min(1).max(10_080).optional().describe('Only events of the last this many minutes.'),
  category: z.enum(CATEGORY_NAMES).optional().describe("Only this log domain, from ABB's event numbering."),
  code: z.number().int().optional().describe('Only this event code.'),
  detail: z.enum(['full', 'summary']).optional().describe('summary (default): title, first sentence and actions. full: every text field.'),
  sinceSeq: z.number().int().min(0).optional().describe('Advanced, for paging: only events after this seq of the same feed.'),
  feed: z.string().regex(FEED).optional().describe('Advanced, for paging: the feed the sinceSeq belongs to.'),
};

export const LIMIT_DEFAULT = 20;
export const ANSWER_BYTES_MAX = 48 * 1024;

export const OUTPUT = z.object({
  ...commonShape,
  feed: z.string().nullable(),
  feedChanged: z.boolean(),
  firstSeq: z.number(),
  lastSeq: z.number(),
  gap: z.boolean(),
  more: z.boolean(),
  matched: z.number(),
  returned: z.number(),
  truncated: z.boolean(),
  via: z.enum(['subscription', 'poll']).nullable(),
  asOf: z.string().nullable(),
  ageS: z.number().nullable(),
  clock: z.object({ offsetMs: z.number().nullable(), problem: z.boolean() }),
  readError: z.string().nullable(),
  controllerData: z.object({
    events: z.array(EventOut),
    clockProblem: z.string().nullable(),
    readErrorMessage: z.string().nullable(),
    freshnessReasons: z.array(z.string()),
    linkReason: z.string().nullable(),
    groupReasons: z.array(z.object({ group: z.string(), reason: z.string() })),
  }),
});

interface Args {
  controller?: string; limit?: number; minSeverity?: 'info' | 'warning' | 'error'; sinceMinutes?: number;
  category?: string; code?: number; detail?: 'full' | 'summary'; sinceSeq?: number; feed?: string;
}

export async function getEventLog(ctx: Context, args: Args): Promise<ReturnType<typeof ok>> {
  const scope = await scoped(ctx, args.controller);
  const ev = scope.snap.events;
  const currentFeed = ev.feed !== null && FEED.test(ev.feed) ? ev.feed : null;
  let feedChanged = false;
  let since: number | undefined;
  if (args.feed !== undefined && currentFeed !== null && args.feed !== currentFeed) {
    feedChanged = true;
  } else if (args.sinceSeq !== undefined) {
    since = args.sinceSeq;
  }
  const ans = await ctx.daemon.get('events', { id: scope.id }, { since, limit: 256 });
  if (ans.status !== 200) { throw answerError(ans, scope.ready.ids); }
  const page = parseAnswer(EventsPage, ans.body, 'events');
  // This server's time after the last read.
  const s = refreshed(ctx, scope);
  const { snap, now } = s;
  const { common, lines: head } = header(s, ['events']);

  const min = args.minSeverity ?? 'warning';
  const detail = args.detail ?? 'summary';
  const from = args.sinceMinutes !== undefined ? now - args.sinceMinutes * 60_000 : null;
  const matching = page.events
    .filter(e => passes(severityOf(e), min))
    .filter(e => args.category === undefined || categoryOf(e.code) === args.category)
    .filter(e => args.code === undefined || e.code === args.code)
    .filter(e => {
      if (from === null) { return true; }
      const t = windowTime(e);
      return t === null || t >= from;
    })
    .sort((a, b) => b.seq - a.seq);
  let chosen = matching.slice(0, args.limit ?? LIMIT_DEFAULT);

  const rs = reasons(snap, ['events']);
  const build = (list: typeof chosen, truncated: boolean): { out: z.infer<typeof OUTPUT>; text: string } => {
    const events = list.map(e => eventOut(e, now, detail, ctx.config.markCodes ?? null));
    const out = {
      ...common,
      feed: FEED.test(page.feed) ? page.feed : null,
      feedChanged,
      firstSeq: page.firstSeq,
      lastSeq: page.lastSeq,
      gap: page.gap,
      more: page.more,
      matched: matching.length,
      returned: events.length,
      truncated,
      via: known(ev.via, ['subscription', 'poll'] as const),
      asOf: validTime(ev.asOf),
      ageS: ageS(ev.asOf, now),
      clock: { offsetMs: ev.clock.offsetMs, problem: ev.clock.problem !== null },
      readError: ev.error && CODE_PATTERN.test(ev.error.code) ? ev.error.code : (ev.error ? 'UNKNOWN' : null),
      controllerData: cleanDeep({
        events,
        clockProblem: ev.clock.problem,
        readErrorMessage: ev.error?.message ?? null,
        ...rs,
      }),
    };
    const t = [...head];
    const filters = [
      `severity ${min} and up (events without a severity always shown)`,
      args.sinceMinutes !== undefined ? `last ${args.sinceMinutes} min` : null,
      args.category !== undefined ? `category ${args.category}` : null,
      args.code !== undefined ? `code ${args.code}` : null,
    ].filter(Boolean).join(', ');
    t.push(`Event log: ${events.length} of ${matching.length} matching events (${filters}), newest first, ${detail === 'full' ? 'full text' : 'summary'}.`
      + `${truncated ? ' Cut to stay under 48 KiB: ask with a lower limit or a filter for the rest.' : ''}`);
    t.push(`Log ${out.via ? `followed by ${out.via}` : 'not being read now'}, complete as of ${when(ev.asOf, now)}.`
      + ` Times are corrected to UTC to about a second, or marked "controller clock, zone unknown".`
      + `${ev.clock.problem !== null ? ' The controller clock could not be read (reason in the block).' : ''}`
      + `${ev.error ? ` The daemon's last read of the log failed (${out.readError}).` : ''}`);
    if (feedChanged) { t.push('The feed changed (the daemon restarted or the controller was added again): this answer starts again from the newest events.'); }
    if (page.gap) { t.push('Gap: events after the given seq were dropped from the daemon\'s memory before this read.'); }
    t.push(`Paging: feed ${out.feed ?? 'unknown'}, seq ${page.firstSeq} to ${page.lastSeq} held${page.more ? ', more follow' : ''}.`);
    const body = events.map((e, i) => eventText(e, list[i], now)).join('\n');
    const extra = ev.clock.problem !== null || ev.error !== null || rs.freshnessReasons.length || rs.linkReason
      ? dataText({ clockProblem: ev.clock.problem, readError: ev.error?.message ?? null, ...rs }, now) : '';
    t.push(blockOf(s.nonce, body || 'no matching events', extra));
    return { out, text: t.join('\n') };
  };

  let truncated = false;
  let r = build(chosen, truncated);
  while (chosen.length > 0 && Buffer.byteLength(r.text) + Buffer.byteLength(JSON.stringify(r.out)) > ANSWER_BYTES_MAX) {
    chosen = chosen.slice(0, -1);
    truncated = true;
    r = build(chosen, truncated);
  }
  return ok(r.text, r.out);
}

export const annotations = ANNOTATIONS;

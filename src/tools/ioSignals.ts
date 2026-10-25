import { z } from 'zod';
import { cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { answerError } from '../daemon.js';
import { errors } from '../errors.js';
import { validTime, when } from '../render.js';
import { SignalList, parseAnswer } from '../schema.js';
import {
  ANNOTATIONS, DESCRIPTION_TAIL, blockOf, commonShape, controllerInput, dataText, header, limitedRead, ok, reasons, refreshed, scoped,
} from './common.js';

export const NAME = 'read_io_signals';
export const DESCRIPTION = "I/O signals and their values. By default from the daemon's signal table in memory (no controller request; values"
  + ' of unknown age). With fresh: true, or a device, network or category, the daemon runs a read-only signal search on the'
  + ' controller, which needs a name prefix of at least 3 characters or a device.'
  + DESCRIPTION_TAIL;

const TYPES = ['DI', 'DO', 'AI', 'AO', 'GI', 'GO'] as const;

export const INPUT = {
  controller: controllerInput,
  name: z.string().min(1).max(160).optional().describe('A name prefix, case ignored. Not a pattern: * matches nothing.'),
  nameContains: z.string().min(1).max(64).optional().describe('A part of the name, anywhere in it, case ignored (e.g. door).'),
  device: z.string().min(1).max(160).optional().describe('Only signals of this I/O device (whole name, case ignored). Searches on the controller.'),
  network: z.string().min(1).max(160).optional().describe('Only signals of this I/O network (whole name, case ignored). Searches on the controller.'),
  category: z.string().min(1).max(160).optional().describe('Only signals of this category (whole name, case ignored). Searches on the controller.'),
  type: z.enum(TYPES).optional().describe('Only this signal type.'),
  fresh: z.boolean().optional().describe('Read current values with a signal search on the controller (default false). Needs a name prefix of at least 3 characters or a device.'),
  limit: z.number().int().min(1).max(500).optional().describe('At most this many signals (default 100).'),
  offset: z.number().int().min(0).optional().describe('Skip this many matching signals (paging).'),
};

export const OUTPUT = z.object({
  ...commonShape,
  how: z.enum(['search', 'table']),
  matched: z.number(),
  returned: z.number(),
  offset: z.number(),
  truncated: z.boolean(),
  tableComplete: z.boolean(),
  controllerData: z.object({
    signals: z.array(z.object({
      name: z.string(), type: z.string().nullable(), value: z.string().nullable(),
      valueFrom: z.enum(['search', 'table', 'watch']), asOf: z.string().nullable(),
    })),
    freshnessReasons: z.array(z.string()),
    linkReason: z.string().nullable(),
    groupReasons: z.array(z.object({ group: z.string(), reason: z.string() })),
  }),
});

interface Args {
  controller?: string; name?: string; nameContains?: string; device?: string; network?: string; category?: string;
  type?: typeof TYPES[number]; fresh?: boolean; limit?: number; offset?: number;
}

export async function readIoSignals(ctx: Context, args: Args): Promise<ReturnType<typeof ok>> {
  const searchAsked = args.device !== undefined || args.network !== undefined || args.category !== undefined || args.fresh === true;
  if (searchAsked && !((args.name?.length ?? 0) >= 3 || args.device !== undefined)) {
    // Refused before anything is sent: a search without a narrow prefix or a device pages the whole table.
    throw errors.searchTooWide();
  }
  const scope = await scoped(ctx, args.controller);
  let list: { name: string; type: string | null; value: string | null }[];
  if (searchAsked) {
    const ans = await limitedRead(ctx, scope.id, () => ctx.daemon.get('signals', { id: scope.id }, {
      name: args.name, device: args.device, network: args.network, category: args.category, type: args.type,
    }));
    if (ans.status !== 200) { throw answerError(ans, scope.ready.ids); }
    list = parseAnswer(SignalList, ans.body, 'signals').signals;
  } else {
    const ans = await ctx.daemon.get('signals', { id: scope.id });
    if (ans.status !== 200) { throw answerError(ans, scope.ready.ids); }
    list = parseAnswer(SignalList, ans.body, 'signals').signals;
    const prefix = args.name?.toLowerCase();
    list = list.filter(x => (prefix === undefined || x.name.toLowerCase().startsWith(prefix))
      && (args.type === undefined || (x.type ?? '').toUpperCase() === args.type));
  }
  if (args.nameContains !== undefined) {
    const part = args.nameContains.toLowerCase();
    list = list.filter(x => x.name.toLowerCase().includes(part));
  }

  // This server's time after the read: a search can take seconds, and its values are as of their answer.
  const s = refreshed(ctx, scope);
  const { snap, now } = s;
  const { common, lines: head } = header(s, ['io']);
  const tableComplete = snap.capabilities.entries.some(e => e.id === 'io-table' && e.state === 'available');
  const watched = new Map(snap.io.signals.filter(w => w.asOf !== null && w.error === null).map(w => [w.name, w]));
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  const page = list.slice(offset, offset + limit);
  const how = searchAsked ? 'search' as const : 'table' as const;
  const signals = page.map(x => {
    const w = watched.get(x.name);
    if (w) { return { name: x.name, type: x.type ?? w.type, value: w.value, valueFrom: 'watch' as const, asOf: validTime(w.asOf) }; }
    return { name: x.name, type: x.type, value: x.value, valueFrom: how, asOf: how === 'search' ? new Date(now).toISOString() : null };
  });
  const rs = reasons(snap, ['io']);
  const out = {
    ...common,
    how,
    matched: list.length,
    returned: signals.length,
    offset,
    truncated: offset + signals.length < list.length,
    tableComplete,
    controllerData: cleanDeep({ signals, ...rs }),
  };

  const t = [...head];
  t.push(how === 'search'
    ? `Signal search on the controller: ${out.matched} matched, ${out.returned} shown${offset ? ` from ${offset}` : ''}. Values as read now.`
    : `Signal table from the daemon's memory: ${out.matched} matched, ${out.returned} shown${offset ? ` from ${offset}` : ''}.`
      + ' Table values are of unknown age; for a current value, ask again with fresh: true and the exact name.');
  if (out.truncated) { t.push('More signals match: ask again with a higher offset.'); }
  if (!tableComplete && how === 'table') { t.push('The table may list only the first 100 signals on this controller: a narrow fresh search finds the rest.'); }
  t.push('name is a prefix, not a pattern (* matches nothing); nameContains finds a word anywhere in the name. Values are raw text as the controller gives them (1, 0, analog as text).');
  const body = out.controllerData.signals.map(x => `- ${JSON.stringify(x.name)} ${x.type ?? 'type unknown'} = ${x.value === null ? 'no value' : JSON.stringify(x.value)}`
    + ` (${x.valueFrom === 'watch' ? `watched, as of ${when(x.asOf, now)}` : x.valueFrom === 'search' ? 'searched now' : 'from the table, age unknown'})`).join('\n');
  const hasReasons = rs.freshnessReasons.length > 0 || rs.linkReason !== null || rs.groupReasons.length > 0;
  t.push(blockOf(s.nonce, body || 'no matching signals', hasReasons ? dataText(rs, now) : ''));
  return ok(t.join('\n'), out);
}

export const annotations = ANNOTATIONS;

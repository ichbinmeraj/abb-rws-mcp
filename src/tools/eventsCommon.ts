import { z } from 'zod';
import { clean, cleanOrNull, firstSentence } from '../clean.js';
import { ageS, duration, parseTime, validTime, when } from '../render.js';
import type { ControllerEvent } from '../schema.js';

/**
 * Event-log helpers shared by get_event_log and summarize_controller: the
 * category from ABB's event numbering, the time to show and to filter on,
 * severity, and the rendering of one event inside a block.
 */

/**
 * ABB's event numbering: the first digits of a code name the log domain
 * (code / 10000). Domain names as ABB's Elog Service page lists them.
 */
export const CATEGORIES: Readonly<Record<number, string>> = {
  1: 'operational', 2: 'system', 3: 'hardware', 4: 'program', 5: 'motion', 7: 'io-communication', 8: 'user',
  9: 'safety', 10: 'internal', 11: 'process', 12: 'configuration', 13: 'paint', 15: 'rapid', 17: 'connected-services',
};
export const CATEGORY_NAMES = Object.values(CATEGORIES) as [string, ...string[]];

export function categoryOf(code: number | null): string | null {
  if (code === null || !Number.isInteger(code) || code < 10000) { return null; }
  return CATEGORIES[Math.floor(code / 10000)] ?? null;
}

export type Severity = 'info' | 'warning' | 'error' | 'other';
export const SEVERITY_RANK: Record<Severity, number> = { other: -1, info: 0, warning: 1, error: 2 };

export function severityOf(e: ControllerEvent): Severity {
  return e.severity === 'info' || e.severity === 'warning' || e.severity === 'error' ? e.severity : 'other';
}

/** Passes a minimum severity; `other` (no or an unknown severity) passes every filter, so none is dropped silently. */
export function passes(sev: Severity, min: 'info' | 'warning' | 'error'): boolean {
  return sev === 'other' || SEVERITY_RANK[sev] >= SEVERITY_RANK[min];
}

/** The time a window applies to: the corrected time, else when the daemon received it (not for backlog events); null when unknown. */
export function windowTime(e: ControllerEvent): number | null {
  if (e.time.corrected) { return parseTime(e.time.utc); }
  return e.backlog ? null : parseTime(e.receivedAt);
}

export function timeNotes(e: ControllerEvent): string[] {
  const notes: string[] = [];
  if (!e.time.corrected) { notes.push('controller clock, zone unknown'); }
  if (e.backlog) { notes.push('already in the log when the daemon started'); }
  return notes;
}

/** The event's time for the text: one time, with its notes. */
export function eventWhen(e: ControllerEvent, now: number): string {
  const notes = timeNotes(e);
  if (e.time.corrected && parseTime(e.time.utc) !== null) {
    return `${when(e.time.utc, now)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  }
  const t = parseTime(e.time.utc);
  const clock = t === null ? 'an unknown time' : `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')}`;
  const received = !e.backlog && parseTime(e.receivedAt) !== null
    ? `; the daemon received it ${duration(Math.round((now - parseTime(e.receivedAt)!) / 1000))} ago` : '';
  return `${clock} (${notes.join('; ')}${received})`;
}

export const EventOut = z.object({
  seq: z.number(),
  code: z.number().nullable(),
  category: z.string().nullable(),
  severity: z.enum(['info', 'warning', 'error', 'other']),
  title: z.string(),
  titleFromCode: z.boolean(),
  at: z.string().nullable(),
  ageS: z.number().nullable(),
  timeNotes: z.array(z.string()),
  time: z.object({ utc: z.string().nullable(), raw: z.string().nullable(), corrected: z.boolean() }),
  receivedAt: z.string().nullable(),
  backlog: z.boolean(),
  source: z.string().nullable(),
  description: z.string().nullable(),
  causes: z.string().nullable(),
  consequences: z.string().nullable(),
  actions: z.string().nullable(),
  args: z.array(z.object({ type: z.string(), value: z.string() })),
});
export type EventOut = z.infer<typeof EventOut>;

/** One event for structuredContent, every controller string cleaned; `summary` keeps the title, the first sentence and the actions. */
export function eventOut(e: ControllerEvent, now: number, detail: 'full' | 'summary'): EventOut {
  const sev = severityOf(e);
  const at = e.time.corrected ? validTime(e.time.utc) : validTime(e.time.utc);
  const full = detail === 'full';
  const keepText = full || sev !== 'info';
  return {
    seq: e.seq,
    code: e.code,
    category: categoryOf(e.code),
    severity: sev,
    title: clean(e.title),
    titleFromCode: e.titleFromCode,
    at,
    ageS: e.time.corrected ? ageS(e.time.utc, now) : null,
    timeNotes: timeNotes(e),
    time: { utc: validTime(e.time.utc), raw: cleanOrNull(e.time.raw, 64), corrected: e.time.corrected },
    receivedAt: validTime(e.receivedAt),
    backlog: e.backlog,
    source: cleanOrNull(e.source, 64),
    description: keepText ? cleanOrNull(full ? e.description : firstSentence(e.description)) : null,
    causes: full ? cleanOrNull(e.causes) : null,
    consequences: full ? cleanOrNull(e.consequences) : null,
    actions: keepText ? cleanOrNull(e.actions) : null,
    args: e.args.slice(0, 16).map(a => ({ type: clean(a.type, 64), value: clean(a.value, 256) })),
  };
}

/** One event as text, for inside a block. Args appear only when the title was made from the code. */
export function eventText(e: EventOut, raw: ControllerEvent, now: number): string {
  const head = `- seq ${e.seq}, ${e.severity}, code ${e.code ?? 'none'}${e.category ? ` (${e.category})` : ''}: ${JSON.stringify(e.title)}`;
  const lines = [head, `  at ${eventWhen(raw, now)}`];
  const add = (k: string, v: string | null): void => {
    if (v === null || v === '') { return; }
    if (v.includes('\n')) {
      lines.push(`  ${k}: |`);
      for (const l of v.split('\n')) { lines.push(`    ${l}`); }
    } else {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  };
  add('description', e.description);
  add('causes', e.causes);
  add('consequences', e.consequences);
  add('actions', e.actions);
  if (e.titleFromCode && e.args.length) { lines.push(`  args: ${e.args.map(a => JSON.stringify(a.value)).join(', ')}`); }
  return lines.join('\n');
}

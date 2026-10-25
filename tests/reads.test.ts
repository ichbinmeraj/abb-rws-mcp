import { afterEach, describe, expect, it } from 'vitest';
import { FakeDaemon } from './fakeDaemon.js';
import { MAIN_MODULE, event, signalTable, snapshot, stoppedCell } from './fixtures/snapshot.js';
import { allAllowed, harness, splitBlocks, structured, text, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function cell(events = stoppedCell().events, signals = signalTable()): Promise<Harness> {
  const fake = await new FakeDaemon().start();
  fake.add(snapshot({ events: events.slice(-20) }), events, signals);
  fake.modules.set('cell-1/T_ROB1/MainModule', MAIN_MODULE);
  return harness({ fake });
}

const searches = (fake: FakeDaemon) => fake.log.filter(r => r.url.startsWith('/v0/controllers/cell-1/io/signals?'));

describe('read_io_signals', () => {
  it('the table by default: prefix, part and type filtered here, no controller request', async () => {
    h = await cell();
    const r = await h.call('read_io_signals', { name: 'di' });
    const s = structured(r);
    expect(s.how).toBe('table');
    expect(s.controllerData.signals.map((x: { name: string }) => x.name)).toEqual(['diPartPresent', 'diDoorClosed']);
    expect(s.controllerData.signals[0]).toMatchObject({ value: '0', valueFrom: 'table', asOf: null });
    expect(structured(await h.call('read_io_signals', { nameContains: 'door' })).matched).toBe(1);
    expect(structured(await h.call('read_io_signals', { type: 'AI' })).controllerData.signals[0].value).toBe('4.25');
    expect(searches(h.fake)).toHaveLength(0);
    expect(text(r)).toContain('age unknown');
  });

  it('a fresh search by exact name: one search request with the name', async () => {
    h = await cell();
    const r = await h.call('read_io_signals', { name: 'diPartPresent', fresh: true });
    expect(structured(r).how).toBe('search');
    expect(structured(r).controllerData.signals[0]).toMatchObject({ name: 'diPartPresent', value: '0', valueFrom: 'search' });
    const s = searches(h.fake);
    expect(s).toHaveLength(1);
    expect(new URL(s[0].url, 'http://x').searchParams.get('name')).toBe('diPartPresent');
    expect(allAllowed(h.fake)).toBe(true);
  });

  it('type-only, one-letter and device-less searches are refused with nothing sent', async () => {
    h = await cell();
    const before = h.fake.log.length;
    for (const args of [{ type: 'DI', fresh: true }, { name: 'd', fresh: true }, { network: 'Local' }, { category: 'safety', name: 'ab' }]) {
      const r = await h.call('read_io_signals', args);
      expect(text(r)).toMatch(/^\[SEARCH_TOO_WIDE\] /);
    }
    expect(h.fake.log.length).toBe(before);
  });

  it('a third search within 2 s gets a local BUSY', async () => {
    h = await cell();
    expect((await h.call('read_io_signals', { name: 'diP', fresh: true })).isError).toBeFalsy();
    expect((await h.call('read_io_signals', { device: 'DRV_1' })).isError).toBeFalsy();
    const third = await h.call('read_io_signals', { name: 'doG', fresh: true });
    expect(text(third)).toMatch(/^\[BUSY\] The controller's read budget is in use\. Retry in [12] s\.$/);
    expect(searches(h.fake)).toHaveLength(2);
  });

  it('a search answered READ_LIMIT with a short Retry-After is retried once', async () => {
    h = await cell();
    let n = 0;
    h.fake.overrides.push((req, res) => {
      if (!req.url.includes('/io/signals?') || n++ > 0) { return false; }
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: 'busy', code: 'READ_LIMIT' }));
      return true;
    });
    const r = await h.call('read_io_signals', { name: 'diPartPresent', fresh: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect(searches(h.fake)).toHaveLength(2);
  });

  it('NOT_READY while the table is not read', async () => {
    h = await cell();
    h.fake.overrides.push((req, res) => {
      if (!req.url.includes('/io/signals')) { return false; }
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: 'not read', code: 'NOT_READY' }));
      return true;
    });
    expect(text(await h.call('read_io_signals', {}))).toBe('[NOT_READY] The signal table is not read yet on this connection. Retry in 2 s.');
  });

  it('500 signals at most per answer, then offset pages on', async () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ name: `di${String(i).padStart(4, '0')}`, type: 'DI', value: '0' }));
    h = await cell(stoppedCell().events, many);
    const r = structured(await h.call('read_io_signals', { limit: 500 }));
    expect(r.returned).toBe(500);
    expect(r.truncated).toBe(true);
    const next = structured(await h.call('read_io_signals', { limit: 500, offset: 500 }));
    expect(next.returned).toBe(200);
    expect(next.truncated).toBe(false);
    expect((await h.call('read_io_signals', { limit: 501 })).isError).toBe(true);
  });
});

describe('get_event_log', () => {
  it('warnings and up by default, newest first, categories from the code, summary text', async () => {
    h = await cell();
    const r = await h.call('get_event_log', {});
    const ev = structured(r).controllerData.events;
    expect(ev.map((e: { seq: number }) => e.seq)).toEqual([4, 3]);
    expect(ev[0]).toMatchObject({ category: 'program', severity: 'error', causes: null });
    expect(ev[1].category).toBe('motion');
    expect(structured(r).feed).toBe('feed-aaaa1111');
    const full = structured(await h.call('get_event_log', { detail: 'full', code: 41000 })).controllerData.events;
    expect(full).toHaveLength(1);
    expect(full[0].causes).toBe('The input stayed at 0.');
    expect(full[0].description).toBe('The task stopped at a WaitDI that timed out. The input did not reach the value in time.');
    expect(structured(await h.call('get_event_log', { category: 'operational', minSeverity: 'info' })).returned).toBe(3);
    expect(structured(await h.call('get_event_log', { sinceMinutes: 30 })).returned).toBe(1);
  });

  it('an event without a severity shows as other and passes every filter; uncorrected times are marked', async () => {
    const now = Date.now();
    const events = [
      event(now, { seq: 1, code: 120003, severity: null, title: 'Event 120003', titleFromCode: true, ageS: 5, args: [{ type: 'string', value: 'arg-one' }], corrected: false }),
      event(now, { seq: 2, code: 10011, severity: 'info', title: 'Motors ON state', ageS: 4 }),
    ];
    h = await cell(events);
    const r = await h.call('get_event_log', { minSeverity: 'error' });
    const ev = structured(r).controllerData.events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ severity: 'other', category: 'configuration', ageS: null });
    expect(ev[0].timeNotes).toEqual(['controller clock, zone unknown']);
    const t = text(r);
    expect(t).toContain('controller clock, zone unknown; the daemon received it');
    expect(t).toContain('args: "arg-one"');
  });

  it('a feed that changed starts again from the newest; sinceSeq pages', async () => {
    h = await cell();
    const r = structured(await h.call('get_event_log', { feed: 'old-feed', sinceSeq: 3, minSeverity: 'info' }));
    expect(r.feedChanged).toBe(true);
    expect(r.returned).toBe(5);
    const p = structured(await h.call('get_event_log', { feed: 'feed-aaaa1111', sinceSeq: 3, minSeverity: 'info' }));
    expect(p.feedChanged).toBe(false);
    expect(p.controllerData.events.map((e: { seq: number }) => e.seq)).toEqual([5, 4]);
    const urls = h.fake.log.filter(x => x.url.includes('/events')).map(x => x.url);
    expect(urls).toContain('/v0/controllers/cell-1/events?since=3&limit=256');
    expect(urls.every(u => !u.includes('feed'))).toBe(true);
  });

  it('at most 100 events and 48 KiB', async () => {
    const now = Date.now();
    const long = 'x'.repeat(990);
    const events = Array.from({ length: 256 }, (_, i) => event(now, {
      seq: i + 1, code: 40000 + i, severity: 'error', title: `Error ${i}`, ageS: 300 - i,
      description: long, causes: long, consequences: long, actions: long,
    }));
    h = await cell(events);
    const r = await h.call('get_event_log', { limit: 100, detail: 'full' });
    const s = structured(r);
    expect(s.truncated).toBe(true);
    expect(s.returned).toBeLessThan(100);
    expect(Buffer.byteLength(text(r)) + Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(48 * 1024);
    expect(s.controllerData.events[0].seq).toBe(256);
    expect((await h.call('get_event_log', { limit: 101 })).isError).toBe(true);
  });
});

describe('get_rapid_execution and read_rapid_source', () => {
  it('execution: tasks, pointers, meanings; NOT_FOUND for an unknown task', async () => {
    h = await cell();
    const r = structured(await h.call('get_rapid_execution', { task: 't_rob1' }));
    expect(r.execState).toBe('stopped');
    expect(r.controllerData.tasks[0]).toMatchObject({ name: 'T_ROB1', hasMotionPointer: true, pp: { line: 9 } });
    const nf = await h.call('get_rapid_execution', { task: 'T_ROB9' });
    expect(text(nf)).toMatch(/^\[NOT_FOUND\] No such task\. The names known follow, in a block\.\n--- controller data [0-9a-f]{8} ---\ntasks: "T_ROB1"/);
  });

  it('source: a routine, the lines around a line, a page; five reads, one daemon request', async () => {
    h = await cell();
    const routine = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule', routine: 'twice' }));
    expect(routine).toMatchObject({ fromLine: 12, toLine: 14, totalLines: 18, kind: 'program', changeCount: 3 });
    expect(routine.controllerData.text.split('\n')[0]).toBe('  FUNC num twice(num x)');
    const trap = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule', routine: 'ONSTOP' }));
    expect([trap.fromLine, trap.toLine]).toEqual([15, 17]);
    const around = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule', aroundLine: 9, context: 1 }));
    expect([around.fromLine, around.toLine]).toEqual([8, 10]);
    const page = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule', fromLine: 17, maxLines: 10 }));
    expect([page.fromLine, page.toLine]).toEqual([17, 18]);
    const r = await h.call('read_rapid_source', { task: 'T_ROB1', module: 'mainmodule' });
    expect(structured(r).fromCache).toBe(true);
    expect(text(r)).toMatch(/```rapid\n 1  MODULE MainModule/);
    expect(h.fake.log.filter(x => x.url.includes('/modules/'))).toHaveLength(1);
  });

  it('a module or routine not listed: NOT_FOUND with the names in a block, and no controller read for a module', async () => {
    h = await cell();
    const m = await h.call('read_rapid_source', { task: 'T_ROB1', module: 'Nope' });
    expect(text(m)).toMatch(/^\[NOT_FOUND\] No such module\./);
    expect(splitBlocks(text(m)).inside).toContain('"MainModule"');
    expect(h.fake.log.filter(x => x.url.includes('/modules/'))).toHaveLength(0);
    const rt = await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule', routine: 'nothere' });
    expect(text(rt)).toMatch(/^\[NOT_FOUND\] No such routine\./);
    expect(splitBlocks(text(rt)).inside).toContain('"pick"');
  });

  it('1,000 lines and 32 KiB per answer; a line over 2,000 characters is cut and marked', async () => {
    h = await cell();
    const lines = ['MODULE Big', ...Array.from({ length: 1500 }, (_, i) => `  ! line ${i} ${'z'.repeat(40)}`), `  ! ${'y'.repeat(2500)}`, 'ENDMODULE'];
    h.fake.modules.set('cell-1/T_ROB1/BASE', lines.join('\n'));
    const r = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'BASE', fromLine: 1, maxLines: 1000 }));
    expect(r.truncated).toBe(true);
    expect(r.toLine - r.fromLine + 1).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(r.controllerData.text)).toBeLessThanOrEqual(32 * 1024);
    const cut = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'BASE', fromLine: 1502, maxLines: 1 }));
    expect(cut.controllerData.text.length).toBe(2000 + ' [cut]'.length);
    expect(cut.controllerData.text.endsWith(' [cut]')).toBe(true);
  });
});

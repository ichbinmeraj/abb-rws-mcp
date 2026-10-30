import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseArgs, parseCodeList } from '../src/config.js';
import { FIRST_SAMPLE_MS, FIRST_SAMPLE_RWS1_MS } from '../src/tools/position.js';
import { FakeDaemon, sampleOnRead } from './fakeDaemon.js';
import { MAIN_MODULE, event, health, signalTable, snapshot, stoppedCell } from './fixtures/snapshot.js';
import { allAllowed, harness, splitBlocks, structured, text, type Harness } from './helpers.js';

// The 0.2.0 read set: read_rapid_variable, explain_event, the state line of
// list_controllers, provenance, the mark-codes list, and every tool on each
// tested build. Every answer here is hand-written: made-up values, synthetic titles.

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const KEY = 'cell-1/T_ROB1/MainModule';
const FEED = 'feed-aaaa1111';

async function cell(opts: { rw?: [number, number]; markCodes?: Set<number>; schema?: string } = {}): Promise<Harness> {
  const fake = await new FakeDaemon().start();
  if (opts.schema) { fake.schemaVersion = opts.schema; }
  const c = stoppedCell();
  const snap = opts.rw ? snapshot({ rw: opts.rw, events: c.events, execState: 'stopped' }) : c.snap;
  fake.add(snap, c.events, signalTable());
  fake.modules.set(KEY, MAIN_MODULE);
  fake.values.set(`${KEY}/nParts`, '12');
  return harness({ fake, markCodes: opts.markCodes ?? null });
}

const symbolRequests = (fake: FakeDaemon) => fake.log.filter(r => r.url.includes('/symbols/'));

describe('read_rapid_variable', () => {
  it('answers the controller\'s text in a block, untyped, with its provenance', async () => {
    h = await cell();
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nParts' });
    expect(r.isError, text(r)).toBeFalsy();
    const s = structured(r);
    expect(s.controllerData.value).toBe('12');
    expect(s).toMatchObject({ task: 'T_ROB1', module: 'MainModule', symbol: 'nParts', truncated: false, typed: false });
    expect(s.provenance).toMatchObject({
      controller: 'cell-1', virtual: true, robotWare: '7.21.0+100', via: 'controller',
      resource: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data',
    });
    expect(s.provenance.ageS).toBeGreaterThanOrEqual(0);
    const { inside, outside } = splitBlocks(text(r));
    expect(inside).toContain('12');
    expect(outside).toContain('The controller gives no type with it');
    expect(outside).toContain('Provenance: cell-1, a virtual controller, RobotWare 7.21.0+100');
    expect(symbolRequests(h.fake).map(q => q.url)).toEqual(['/v0/controllers/cell-1/rapid/tasks/T_ROB1/modules/MainModule/symbols/nParts']);
    expect(allAllowed(h.fake)).toBe(true);
  });

  it('a string keeps its quotes and its doubled inner quote; an entity character stays as it is', async () => {
    h = await cell();
    h.fake.values.set(`${KEY}/sLabel`, '"a<b>c&d""e\'f"');
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'sLabel' });
    expect(structured(r).controllerData.value).toBe('"a<b>c&d""e\'f"');
  });

  it('a value over 16,384 characters is cut and says so', async () => {
    h = await cell();
    h.fake.values.set(`${KEY}/bigArray`, `[${'1,'.repeat(12_000)}1]`);
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'bigArray' });
    const s = structured(r);
    expect(s.truncated).toBe(true);
    expect(s.controllerData.value).toBe(`[${'1,'.repeat(12_000)}1]`.slice(0, 16_384));
    expect(text(r)).toContain('cut at 16,384 characters');
  });

  it('this server cuts too: a longer value the daemon did not mark is cut at 16,384 and says so', async () => {
    h = await cell();
    const long = 'x'.repeat(20_000);
    h.fake.values.set(`${KEY}/sLong`, { status: 200, body: {
      task: 'T_ROB1', module: 'MainModule', symbol: 'sLong', value: long, truncated: false,
      resource: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data', readAt: new Date().toISOString(),
    } });
    const s = structured(await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'sLong' }));
    expect(s.truncated).toBe(true);
    expect(s.controllerData.value).toBe(long.slice(0, 16_384));
  });

  it('a resource that is not the template of this generation reads unknown', async () => {
    h = await cell();
    h.fake.values.set(`${KEY}/nOther`, { status: 200, body: {
      task: 'T_ROB1', module: 'MainModule', symbol: 'nOther', value: '1', truncated: false,
      resource: '/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}', readAt: new Date().toISOString(),
    } });
    const s = structured(await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nOther' }));
    expect(s.provenance.resource).toBe('unknown');
  });

  it('MODULE_NOT_FOUND from the daemon is SYMBOL_NOT_FOUND too; NOT_RECORDED and NO_ROUTE get their own answers', async () => {
    h = await cell();
    h.fake.values.set(`${KEY}/zzMod`, { status: 404, body: { error: 'no module', code: 'MODULE_NOT_FOUND', controller: { httpStatus: 400, code: -1073442813, message: null } } });
    const m = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'zzMod' });
    expect(text(m)).toMatch(/^\[SYMBOL_NOT_FOUND\] /);
    expect(splitBlocks(text(m)).inside).toContain('-1073442813');
    h.fake.values.set(`${KEY}/zzRec`, { status: 404, body: { error: 'not recorded', code: 'NOT_RECORDED' } });
    expect(text(await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'zzRec' }))).toMatch(/^\[NOT_FOUND\] .*recorded value/);
    await new Promise(r => setTimeout(r, 2100));   // this server's own limit: two reads, then one every 2 s
    h.fake.values.set(`${KEY}/zzRoute`, { status: 404, body: { error: 'no route', code: 'NO_ROUTE' } });
    expect(text(await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'zzRoute' }))).toMatch(/^\[DAEMON_TOO_OLD\] /);
  });

  it('no value from the controller is VALUE_NOT_READ, never an empty value', async () => {
    h = await cell();
    h.fake.values.set(`${KEY}/hugeArray`, { status: 502, body: { error: 'no value', code: 'VALUE_NOT_READ' } });
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'hugeArray' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^\[VALUE_NOT_READ\] /);
    h.fake.values.set(`${KEY}/emptyText`, '');
    const e = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'emptyText' });
    expect(text(e)).toMatch(/^\[VALUE_NOT_READ\] /);
  });

  it('an unknown symbol is SYMBOL_NOT_FOUND with the controller\'s code, and does not guess which part is missing', async () => {
    h = await cell();
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'zzNone' });
    expect(text(r)).toMatch(/^\[SYMBOL_NOT_FOUND\] The controller does not know that task, module or symbol\./);
    expect(splitBlocks(text(r)).inside).toContain('-1073442816');
  });

  it('a task or module the snapshot does not list costs no controller read', async () => {
    h = await cell();
    const m = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'NoSuchMod', symbol: 'x' });
    expect(text(m)).toMatch(/^\[NOT_FOUND\] No such module\./);
    const t = await h.call('read_rapid_variable', { task: 'T_ROB9', module: 'MainModule', symbol: 'x' });
    expect(text(t)).toMatch(/^\[NOT_FOUND\] No such task\./);
    expect(symbolRequests(h.fake)).toHaveLength(0);
  });

  it('daemon 0.1.0 (schema 0.14) is refused before any request; the other tools still work', async () => {
    h = await cell({ schema: '0.14' });
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nParts' });
    expect(text(r)).toMatch(/^\[DAEMON_TOO_OLD\] This tool needs abb-rws-daemon 0\.1\.1 or later \(snapshot schema 0\.15\)\. The daemon serves 0\.14\./);
    expect(symbolRequests(h.fake)).toHaveLength(0);
    expect((await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule' })).isError).toBeFalsy();
  });

  it('RWS 1.0 names its own resource', async () => {
    h = await cell({ rw: [6, 16] });
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nParts' });
    expect(structured(r).provenance).toMatchObject({ robotWare: '6.16.0+100', resource: '/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}' });
  });
});

describe('explain_event', () => {
  it('splits what the controller says from our reading, names the RAPID line and lists the events around it', async () => {
    h = await cell();
    const r = await h.call('explain_event', { code: 41000 });
    expect(r.isError, text(r)).toBeFalsy();
    const s = structured(r);
    expect(s.seq).toBe(4);
    expect(s.marked).toBeNull();
    expect(s.controllerData.controllerSays).toMatchObject({
      code: 41000, severity: 'error', title: 'Synthetic RAPID error: WaitDI timed out', causes: 'The input stayed at 0.',
    });
    expect(s.ourReading).toMatchObject({
      category: 'program', severity: 'error', severityMeaning: 'The controller logged it as an error.', backlog: false,
      rapidLine: {
        task: 'T_ROB1', taskFrom: 'event', module: 'MainModule', routine: 'pick', line: 9, read: true, problem: null,
        via: 'controller', resource: '/rw/rapid/tasks/{task}/modules/{module}/text',
      },
    });
    expect(s.controllerData.rapidLineText).toContain('WaitDI diPartPresent');
    // Within 60 s: only "Program stopped", one second after.
    expect(s.around).toEqual({ by: 'time', windowS: 60, before: 0, after: 1 });
    expect(s.controllerData.around.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect(s.notShown).toBe('The data does not show the cause. These are the events around it.');
    expect(s.provenance).toMatchObject({ controller: 'cell-1', via: 'snapshot', resource: '/rw/elog/0' });
    const { inside, outside } = splitBlocks(text(r));
    expect(inside).toContain('The controller says:');
    expect(inside).toContain('Check the part sensor');
    expect(outside).not.toContain('Check the part sensor');
    expect(outside).toContain('The event names line 9 of module MainModule (routine pick) in task T_ROB1, which the event names.');
    expect(outside).toContain('as the module reads from the controller, read at');
    expect(outside).toContain('The data does not show the cause.');
    expect(allAllowed(h.fake)).toBe(true);
  });

  it('by seq; a wider window takes the earlier events in', async () => {
    h = await cell();
    const r = await h.call('explain_event', { seq: 4, feed: FEED, aroundS: 600 });
    expect(structured(r).around).toEqual({ by: 'time', windowS: 600, before: 2, after: 1 });
  });

  it('an unknown seq is NOT_FOUND with the range the feed holds; a changed feed is FEED_CHANGED; no seq or code is refused', async () => {
    h = await cell();
    const r = await h.call('explain_event', { seq: 99, feed: FEED });
    expect(text(r)).toMatch(/^\[NOT_FOUND\] No such event with that seq\./);
    expect(splitBlocks(text(r)).inside).toMatch(/lastSeq: 5/);
    const f = await h.call('explain_event', { seq: 4, feed: 'feed-bbbb2222' });
    expect(text(f)).toMatch(/^\[FEED_CHANGED\] /);
    const n = await h.call('explain_event', {});
    expect(text(n)).toMatch(/^\[NOT_FOUND\] No event named\./);
  });

  it('an event without a known time lists its neighbours by seq', async () => {
    const fake = await new FakeDaemon().start();
    const now = Date.now();
    const events = [1, 2, 3, 4, 5, 6, 7].map(seq => event(now, {
      seq, code: 10000 + seq, severity: 'info', title: `Synthetic ${seq}`, ageS: 100 - seq, corrected: false, backlog: true,
    }));
    fake.add(snapshot({ now, events }), events);
    h = await harness({ fake });
    const r = await h.call('explain_event', { seq: 4, feed: FEED });
    expect(structured(r).around).toEqual({ by: 'seq', windowS: null, before: 3, after: 3 });
    expect(text(r)).toContain("the event's time is not known");
  });

  it('a program reference whose module no task lists is left alone: no module read', async () => {
    const fake = await new FakeDaemon().start();
    const now = Date.now();
    const events = [event(now, { seq: 1, code: 41001, severity: 'error', title: 'Synthetic', ageS: 5, args: [{ type: 'string', value: '/OtherMod/main/MoveJ/3' }] })];
    fake.add(snapshot({ now, events }), events);
    h = await harness({ fake });
    const r = await h.call('explain_event', { seq: 1, feed: FEED });
    expect(structured(r).ourReading.rapidLine).toBeNull();
    expect(fake.log.filter(q => q.url.includes('/modules/'))).toHaveLength(0);
  });

  it('a seq needs its feed (FEED_NEEDED, nothing asked); a seq and a code of different events are refused', async () => {
    h = await cell();
    const n = await h.call('explain_event', { seq: 4 });
    expect(text(n)).toMatch(/^\[FEED_NEEDED\] /);
    expect(h.fake.log.filter(q => q.url.includes('/events'))).toHaveLength(0);
    const c = await h.call('explain_event', { seq: 4, feed: FEED, code: 10002 });
    expect(text(c)).toMatch(/^\[NOT_FOUND\] Event seq 4 has code 41000, not 10002\./);
  });

  it('summarize_controller gives the feed its seqs belong to', async () => {
    h = await cell();
    const r = await h.call('summarize_controller', {});
    expect(structured(r).feed).toBe(FEED);
    expect(text(r)).toContain(`belong to feed ${FEED}`);
  });

  const withArgs = async (args: { type: string; value: string }[], tasks?: (snap: ReturnType<typeof snapshot>) => void): Promise<Harness> => {
    const fake = await new FakeDaemon().start();
    const now = Date.now();
    const events = [event(now, { seq: 1, code: 41001, severity: 'error', title: 'Synthetic', ageS: 5, args })];
    const snap = snapshot({ now, events });
    tasks?.(snap);
    fake.add(snap, events);
    fake.modules.set(KEY, MAIN_MODULE);
    return harness({ fake });
  };

  it('an event naming a task that does not list the module gets no line, even when another task lists it', async () => {
    h = await withArgs([{ type: 'string', value: 'T_ROB2' }, { type: 'string', value: '/MainModule/pick/WaitDI/9' }],
      snap => { snap.rapid.tasks.push({ ...snap.rapid.tasks[0], name: 'T_ROB2', modules: [] }); });
    const r = await h.call('explain_event', { seq: 1, feed: FEED });
    expect(structured(r).ourReading.rapidLine).toBeNull();
    expect(h.fake.log.filter(q => q.url.includes('/modules/'))).toHaveLength(0);
  });

  it('with no task in the args, the one task that lists the module is used and marked inferred', async () => {
    h = await withArgs([{ type: 'string', value: '/MainModule/pick/WaitDI/9' }]);
    const r = await h.call('explain_event', { seq: 1, feed: FEED });
    expect(structured(r).ourReading.rapidLine).toMatchObject({ task: 'T_ROB1', taskFrom: 'inferred', read: true });
    expect(text(r)).toContain('(inferred: no arg of the event is a task of this controller');
  });

  it('a line past the module\'s end is LINE_NOT_IN_MODULE; a module that cannot be read gives its problem, no line text', async () => {
    h = await withArgs([{ type: 'string', value: 'T_ROB1' }, { type: 'string', value: '/MainModule/pick/WaitDI/999' }]);
    const r = structured(await h.call('explain_event', { seq: 1, feed: FEED }));
    expect(r.ourReading.rapidLine).toMatchObject({ read: true, problem: 'LINE_NOT_IN_MODULE' });
    expect(r.controllerData.rapidLineText).toBeNull();
    await h.close();
    h = await withArgs([{ type: 'string', value: 'T_ROB1' }, { type: 'string', value: '/BASE/main/MoveJ/3' }]);
    const b = structured(await h.call('explain_event', { seq: 1, feed: FEED }));
    expect(b.ourReading.rapidLine).toMatchObject({ module: 'BASE', read: false, via: null });
    expect(b.ourReading.rapidLine.problem).toMatch(/^[A-Z_]+$/);
    expect(b.controllerData.rapidLineText).toBeNull();
  });

  it('a line from this server\'s cache says so', async () => {
    h = await cell();
    await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule' });
    const r = await h.call('explain_event', { code: 41000 });
    expect(structured(r).ourReading.rapidLine).toMatchObject({ via: 'cache', read: true });
    expect(text(r)).toContain("as the module reads from this server's cache");
    expect(h.fake.log.filter(q => /\/modules\/[^/]+$/.test(q.url))).toHaveLength(1);
  });

  it('a program reference past the 16 args shown is not used', async () => {
    const filler = Array.from({ length: 16 }, (_, i) => ({ type: 'long', value: String(i) }));
    h = await withArgs([...filler, { type: 'string', value: '/MainModule/pick/WaitDI/9' }]);
    expect(structured(await h.call('explain_event', { seq: 1, feed: FEED })).ourReading.rapidLine).toBeNull();
  });

  it('our reading gives no time when the daemon could not correct it to UTC', async () => {
    const fake = await new FakeDaemon().start();
    const now = Date.now();
    const events = [event(now, { seq: 1, code: 10002, severity: 'info', title: 'Synthetic', ageS: 5, corrected: false })];
    fake.add(snapshot({ now, events }), events);
    h = await harness({ fake });
    const r = structured(await h.call('explain_event', { seq: 1, feed: FEED }));
    expect(r.ourReading.at).toBeNull();
    expect(r.ourReading.timeNotes.length).toBeGreaterThan(0);
  });
});

describe('replay', () => {
  const replayCell = async (schema?: string): Promise<Harness> => {
    const fake = await new FakeDaemon().start();
    if (schema) { fake.schemaVersion = schema; }
    fake.health = health({ mode: 'replay' });
    const c = stoppedCell();
    const snap = snapshot({ events: c.events, execState: 'stopped', mode: 'replay' });
    fake.add(snap, c.events, signalTable());
    fake.modules.set(KEY, MAIN_MODULE);
    fake.values.set(`${KEY}/nParts`, '12');
    return harness({ fake, allowReplay: true });
  };

  it('provenance says recording, with no module time; the value is not called the robot\'s value now', async () => {
    h = await replayCell();
    const v = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nParts' });
    expect(structured(v).provenance.via).toBe('recording');
    expect(text(v)).toContain('From the recording the daemon replays');
    expect(text(v)).toContain('from a recording the daemon replays');
    const src = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule' }));
    expect(src.provenance).toMatchObject({ via: 'recording', readAt: null });
    const e = structured(await h.call('explain_event', { code: 41000 }));
    expect(e.provenance.via).toBe('recording');
    expect(e.ourReading.rapidLine).toMatchObject({ via: 'recording', readAt: null });
  });

  it('an old recording is said to be one, not an old daemon', async () => {
    h = await replayCell('0.14');
    const r = await h.call('read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nParts' });
    expect(text(r)).toMatch(/^\[NOT_FOUND\] The daemon replays a recording made before RAPID values were recorded \(snapshot schema 0\.14\)/);
  });
});

describe('the mark-codes list', () => {
  it('marks events whose code is listed, in explain_event, get_event_log and the summary; without a list it says null', async () => {
    h = await cell({ markCodes: new Set([41000]) });
    const e = await h.call('explain_event', { seq: 4, feed: FEED });
    expect(structured(e).marked).toBe(true);
    expect(structured(e).controllerData.around[0].marked).toBe(false);
    expect(text(e)).toContain('MARKED');
    const log = await h.call('get_event_log', { minSeverity: 'info' });
    const marks = structured(log).controllerData.events.map((x: { code: number; marked: boolean }) => [x.code, x.marked]);
    expect(marks).toContainEqual([41000, true]);
    expect(marks).toContainEqual([10002, false]);
    const sum = await h.call('summarize_controller', {});
    expect(JSON.stringify(structured(sum))).toContain('"marked":true');
    await h.close();
    h = await cell();
    const plain = await h.call('get_event_log', { minSeverity: 'info' });
    expect(structured(plain).controllerData.events.every((x: { marked: unknown }) => x.marked === null)).toBe(true);
  });

  it('the file: one code per line, # comments, blank lines; anything else is refused by its line number', () => {
    expect([...parseCodeList('﻿41000\r\n# a comment\n 10011 # after a code\n\n')]).toEqual([41000, 10011]);
    expect(() => parseCodeList('41000\nnot-a-code\n')).toThrow(new ConfigError('line 2 of the mark-codes file is not an event code'));
    const p = parseArgs(['--mark-codes', '/x/codes.txt'], {}, 'linux');
    expect(p.kind === 'run' && p.config.markCodesFile).toBe('/x/codes.txt');
    expect(() => parseArgs(['--mark-codes='], {}, 'linux')).toThrow(ConfigError);
  });
});

describe('list_controllers: the state line', () => {
  it('controller state, mode and program state in words, from the list alone', async () => {
    const fake = await new FakeDaemon().start();
    fake.add(snapshot({ id: 'cell-1', ctrlState: 'motoron', opMode: 'AUTO', execState: 'stopped' }));
    fake.add(snapshot({ id: 'cell-2', ctrlState: 'guardstop', opMode: 'MANR', execState: 'running' }));
    fake.add(snapshot({ id: 'cell-3', ctrlState: 'somethingNew', opMode: null, execState: null }));
    fake.add(snapshot({ id: 'cell-4', ctrlState: 'motoron', opMode: 'AUTO', execState: 'running', level: 'down', quality: 'disconnected' }));
    h = await harness({ fake });
    const r = await h.call('list_controllers', {});
    expect(structured(r).controllers.map((c: { state: string }) => c.state)).toEqual([
      'motors on, Auto, stopped',
      'guard stop, manual reduced speed, running',
      'controller state not known, mode not known, program state not known',
      'last known: motors on, Auto, running',
    ]);
    expect(text(r)).toContain('motors on, Auto, stopped');
    expect(fake.log.every(q => !q.url.includes('/rapid/') && !q.url.includes('/events'))).toBe(true);
  });
});

describe('read_rapid_source: provenance', () => {
  it('the first read is from the controller, the next from this server\'s cache', async () => {
    h = await cell();
    const a = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule' }));
    expect(a.provenance).toMatchObject({ via: 'controller', resource: '/rw/rapid/tasks/{task}/modules/{module}/text' });
    const b = structured(await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule' }));
    expect(b.provenance.via).toBe('cache');
  });
});

describe('every tool on each tested build (hand-written answers)', () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ['summarize_controller', {}],
    ['list_controllers', {}],
    ['get_controller_status', {}],
    ['get_robot_position', { fresh: false }],
    ['read_io_signals', {}],
    ['get_event_log', {}],
    ['explain_event', { code: 41000 }],
    ['get_rapid_execution', {}],
    ['read_rapid_source', { task: 'T_ROB1', module: 'MainModule', aroundLine: 9 }],
    ['read_rapid_variable', { task: 'T_ROB1', module: 'MainModule', symbol: 'nParts' }],
  ];
  for (const rw of [[6, 16], [7, 21], [8, 2]] as [number, number][]) {
    it(`RobotWare ${rw[0]}.${rw[1]}`, async () => {
      h = await cell({ rw });
      for (const [name, args] of CALLS) {
        const r = await h.call(name, args);
        expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
        expect(r.structuredContent, name).toBeDefined();
      }
      expect(allAllowed(h.fake)).toBe(true);
      expect(h.fake.log.filter(q => q.method !== 'GET')).toHaveLength(0);
      await h.close();
      h = null;
    });
  }
});

describe('get_robot_position: the first sample on RWS 1.0', () => {
  it('waits 10 s on RWS 1.0 and 6 s otherwise', () => {
    expect(FIRST_SAMPLE_RWS1_MS).toBe(10_000);
    expect(FIRST_SAMPLE_MS).toBe(6_000);
  });

  it('a first sample 7 s after the lease still arrives on RWS 1.0', async () => {
    const fake = await new FakeDaemon().start();
    fake.add(snapshot({ rw: [6, 16], motionAgeS: 30 }));
    fake.onLease = id => { setTimeout(() => sampleOnRead(fake, id, 0.5), 7_000); };
    h = await harness({ fake });
    const r = await h.call('get_robot_position', {});
    expect(r.isError, text(r)).toBeFalsy();
    expect(structured(r).motion.ageS).toBeLessThan(5);
  }, 20_000);
});

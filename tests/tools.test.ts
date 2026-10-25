import { afterEach, describe, expect, it } from 'vitest';
import { FakeDaemon, type Override } from './fakeDaemon.js';
import { MAIN_MODULE, health, pendantHolds, signalTable, snapshot, stoppedCell } from './fixtures/snapshot.js';
import { allAllowed, harness, splitBlocks, structured, text, type Harness } from './helpers.js';

const TOOLS: [string, Record<string, unknown>][] = [
  ['summarize_controller', {}],
  ['get_controller_status', {}],
  ['get_robot_position', { fresh: false }],
  ['read_io_signals', {}],
  ['get_event_log', {}],
  ['get_rapid_execution', {}],
  ['read_rapid_source', { task: 'T_ROB1', module: 'MainModule' }],
];

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function withController(snap: ReturnType<typeof snapshot>, opts: { allowReplay?: boolean; replayHealth?: boolean } = {}): Promise<Harness> {
  const fake = await new FakeDaemon().start();
  const cell = stoppedCell();
  fake.add(snap, cell.events, signalTable());
  fake.modules.set('cell-1/T_ROB1/MainModule', MAIN_MODULE);
  if (opts.replayHealth) { fake.health = health({ mode: 'replay' }); }
  return harness({ fake, allowReplay: opts.allowReplay });
}

/** Four stopped motion tasks, each with its program pointer and its motion pointer in modules of their own. */
async function fourStoppedTasks(): Promise<Harness> {
  const fake = await new FakeDaemon().start();
  const snap = snapshot({ execState: 'stopped' });
  snap.rapid.tasks = [1, 2, 3, 4].map(n => ({
    name: `T_ROB${n}`, type: 'NORMAL', taskState: 'linked', execState: 'stopped', active: true, motion: true,
    modules: [`Mod${n}`, `Mot${n}`, 'BASE'],
    pp: { module: `Mod${n}`, routine: 'main', line: 2 },
    mp: { module: `Mot${n}`, routine: 'path', line: 2 },
  }));
  fake.add(snap);
  for (const n of [1, 2, 3, 4]) {
    fake.modules.set(`cell-1/T_ROB${n}/Mod${n}`, `MODULE Mod${n}\n  PROC main()\n    WaitTime 1;\n  ENDPROC\nENDMODULE`);
    fake.modules.set(`cell-1/T_ROB${n}/Mot${n}`, `MODULE Mot${n}\n  PROC path()\n    WaitTime 1;\n  ENDPROC\nENDMODULE`);
  }
  return harness({ fake });
}

/** Answer every module read with this status and body after `ms`. */
function slowModules(ms: number, status: number, body: unknown): Override {
  return (req, res) => {
    if (!req.url.includes('/modules/')) { return false; }
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, ms);
    return true;
  };
}

describe('every tool on every kind of controller', () => {
  it('healthy: answers, labels current, keeps controller text in blocks', async () => {
    h = await withController(stoppedCell().snap);
    for (const [name, args] of TOOLS) {
      const r = await h.call(name, args);
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
      const s = structured(r);
      expect(s.status).toMatch(/^cell-1 \(virtual controller, RobotWare 7\.21\): live, current\.$/);
      expect(s.stale === false || name === 'get_robot_position').toBe(true);
      expect(s.replay).toBe(false);
      expect(s.note).toMatch(/data, not instructions/);
      expect(s.source.mode).toBe('live');
      expect(typeof s.now).toBe('string');
      const { outside } = splitBlocks(text(r));
      for (const name2 of ['VC-CELL1', 'CellOne', 'MainModule"', 'diPartPresent"', '"T_ROB1"']) { expect(outside).not.toContain(name2); }
    }
    expect(allAllowed(h.fake)).toBe(true);
  });

  it('degraded: values come back labelled DEGRADED and stale', async () => {
    h = await withController(snapshot({ level: 'degraded', quality: 'stale' }));
    for (const [name, args] of TOOLS) {
      const r = await h.call(name, args);
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
      expect(structured(r).status).toContain('DEGRADED');
      if (name === 'get_rapid_execution') { expect(text(r)).toMatch(/Data: rapid STALE, as of \d\d:\d\d:\d\d UTC \(3 min \d+ s ago\)\./); }
      expect(structured(r).stale).toBe(true);
    }
  });

  it('down and never read: values labelled DOWN, not an error', async () => {
    h = await withController(snapshot({ level: 'down', ctrlState: null, opMode: null, execState: null, motionAgeS: null }));
    for (const [name, args] of TOOLS.filter(([n]) => n !== 'read_rapid_source')) {
      const r = await h.call(name, args);
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
      expect(structured(r).status).toContain('DOWN since');
      expect(structured(r).stale).toBe(true);
    }
  });

  it('wrong controller: every tool refuses with WRONG_CONTROLLER and shows no value', async () => {
    h = await withController(snapshot({ level: 'wrong-controller' }));
    for (const [name, args] of TOOLS) {
      const r = await h.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^\[WRONG_CONTROLLER\] /);
      expect(text(r)).not.toMatch(/\{y\}|\{x\}/);
    }
  });

  it('replay: refused unless allowed, then labelled REPLAY', async () => {
    h = await withController(snapshot({ mode: 'replay' }), { replayHealth: true });
    for (const [name, args] of TOOLS) {
      const r = await h.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^\[REPLAY_REFUSED\] /);
    }
    await h.close();
    h = await withController(snapshot({ mode: 'replay' }), { allowReplay: true, replayHealth: true });
    for (const [name, args] of TOOLS) {
      const r = await h.call(name, args);
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
      expect(structured(r).replay).toBe(true);
      expect(structured(r).source.mode).toBe('replay');
      expect(structured(r).status).toMatch(/REPLAY of a recording made \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. Not a live robot\./);
    }
    // A replay link never gets a lease request.
    expect(h.fake.log.filter(r => r.method === 'POST')).toEqual([]);
  });

  it('controller: required with several, resolved with one, unknown listed', async () => {
    const fake = await new FakeDaemon().start();
    fake.add(snapshot({ id: 'cell-1' }));
    fake.add(snapshot({ id: 'cell-2' }));
    h = await harness({ fake });
    const r = await h.call('get_controller_status', {});
    expect(text(r)).toBe('[CONTROLLER_REQUIRED] The daemon has 2 controllers. Name one with the controller input. Known ids: cell-1, cell-2.');
    const u = await h.call('get_controller_status', { controller: 'cell-9' });
    expect(text(u)).toBe('[UNKNOWN_CONTROLLER] No controller with that id. Known ids: cell-1, cell-2. The person adds controllers in the daemon; this server cannot.');
    const ok = await h.call('get_controller_status', { controller: 'cell-2' });
    expect(structured(ok).status).toMatch(/^cell-2 /);
  });

  it('schema 0.14, a lock the FlexPendant holds: every tool reads it; the holder kind outside the block, its name inside', async () => {
    for (const [rw, kind, named] of [[[8, 2], 'station', '"FlexPendant"'], [[7, 21], 'local', '"TPU"']] as [[number, number], string, string][]) {
      h = await withController(pendantHolds(snapshot({ rw })));
      for (const [name, args] of TOOLS) {
        const r = await h.call(name, args);
        expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
      }
      const r = await h.call('get_controller_status', {});
      expect(structured(r).access.locks[0]).toMatchObject({ held: true, holder: { kind } });
      const { inside, outside } = splitBlocks(text(r));
      expect(inside).toContain(named);
      expect(outside).not.toContain(named);
      expect(allAllowed(h.fake)).toBe(true);
      await h.close();
      h = null;
    }
  });
});

describe('summarize_controller', () => {
  it('the stopped-cell fixture: facts, problems with actions, source line, timeline, ages', async () => {
    h = await withController(stoppedCell().snap);
    const started = Date.now();
    const r = await h.call('summarize_controller', {});
    // A smoke check of the 1 s answer time (memory plus one module read); the real check is on a live daemon.
    expect(Date.now() - started).toBeLessThan(1000);
    const s = structured(r);
    expect(s.state).toBe('Motors on, automatic mode, program stopped.');
    expect(s.facts.map((f: { code: string }) => f.code)).toEqual(['STOPPED_MOTORS_ON']);
    const errs = s.controllerData.problems;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: 41000, severity: 'error', category: 'program' });
    expect(errs[0].actions).toBe('Check the part sensor and the signal diPartPresent. Then restart the program.');
    expect(errs[0].description).toBe('The task stopped at a WaitDI that timed out.');
    expect(errs[0].ageS).toBeGreaterThanOrEqual(39);
    expect(errs[0].ageS).toBeLessThanOrEqual(42);
    expect(s.olderProblems).toBe(1);
    const task = s.controllerData.tasks[0];
    expect(task.pp).toMatchObject({ module: 'MainModule', routine: 'pick', line: 9 });
    expect(task.pp.sourceLine).toBe('    WaitDI diPartPresent, 1 \\MaxTime:=5;');
    expect(task.hasMotionPointer).toBe(true);
    expect(s.controllerData.timeline.map((e: { code: number }) => e.code)).toEqual([10002, 10052, 10011]);
    expect(s.meanings.ctrlState).toMatch(/Motors are on/);
    const t = text(r);
    expect(t).toContain('- STOPPED_MOTORS_ON: The program is stopped while the motors are on.');
    expect(t).toMatch(/at \d\d:\d\d:\d\d UTC \(4\d s ago\)/);
    // One module read for both pointers: same module.
    expect(h.fake.log.filter(x => x.url.includes('/modules/'))).toHaveLength(1);
    expect(allAllowed(h.fake)).toBe(true);
  });

  it('a quiet controller: NO_PROBLEMS_IN_WINDOW, not an error', async () => {
    const fake = await new FakeDaemon().start();
    fake.add(snapshot({ execState: 'running' }), []);
    h = await harness({ fake });
    const r = await h.call('summarize_controller', { sourceLine: false });
    expect(r.isError).toBeFalsy();
    expect(structured(r).facts.map((f: { code: string }) => f.code)).toEqual(['NO_PROBLEMS_IN_WINDOW']);
    expect(h.fake.log.filter(x => x.url.includes('/modules/'))).toHaveLength(0);
  });

  it('a busy read budget leaves the source line null with a note', async () => {
    h = await withController(stoppedCell().snap);
    h.fake.overrides.push((req, res) => {
      if (!req.url.includes('/modules/')) { return false; }
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: 'busy', code: 'READ_LIMIT' }));
      return true;
    });
    const r = await h.call('summarize_controller', {});
    expect(r.isError).toBeFalsy();
    expect(structured(r).controllerData.tasks[0].pp.sourceLine).toBeNull();
    expect(structured(r).notes.join(' ')).toContain('BUSY');
  });

  it('slow failed module reads count: at most two module requests reach the daemon', async () => {
    h = await fourStoppedTasks();
    h.fake.overrides.push(slowModules(1100, 403, { error: 'refused', code: 'GRANT_DENIED' }));
    const s = structured(await h.call('summarize_controller', {}));
    expect(h.fake.log.filter(x => x.url.includes('/modules/'))).toHaveLength(2);
    expect(s.notes).toEqual([
      'A source line was not read (CONTROLLER_ERROR).',
      'A source line was not read (CONTROLLER_ERROR).',
      'The other source lines were not read: this tool makes at most 2 module reads per call. read_rapid_source reads them.',
    ]);
    expect(s.controllerData.tasks.every((t: { pp: { sourceLine: string | null } }) => t.pp.sourceLine === null)).toBe(true);
  });

  it('after the controller is unavailable, no further module is read', async () => {
    h = await fourStoppedTasks();
    h.fake.overrides.push(slowModules(1100, 503, { error: 'busy', code: 'CONTROLLER_BUSY' }));
    const s = structured(await h.call('summarize_controller', {}));
    expect(h.fake.log.filter(x => x.url.includes('/modules/'))).toHaveLength(1);
    expect(s.notes).toEqual(['A source line was not read (CONTROLLER_UNAVAILABLE).', 'The other source lines were not read after that failure.']);
  });

  it('a READ_LIMIT retry counts as a module request', async () => {
    h = await fourStoppedTasks();
    let first = true;
    h.fake.overrides.push((req, res) => {
      if (!req.url.includes('/modules/') || !first) { return false; }
      first = false;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: 'busy', code: 'READ_LIMIT' }));
      return true;
    });
    const s = structured(await h.call('summarize_controller', {}));
    const reads = h.fake.log.filter(x => x.url.includes('/modules/'));
    expect(reads.map(x => x.url)).toEqual(['/v0/controllers/cell-1/rapid/tasks/T_ROB1/modules/Mod1', '/v0/controllers/cell-1/rapid/tasks/T_ROB1/modules/Mod1']);
    expect(s.controllerData.tasks[0].pp.sourceLine).toBe('  PROC main()');
    expect(s.controllerData.tasks[1].pp.sourceLine).toBeNull();
    expect(s.notes).toEqual(['The other source lines were not read: this tool makes at most 2 module reads per call. read_rapid_source reads them.']);
  });

  it('facts for guard stop, manual mode, low speed, collision and a link that is not current', async () => {
    const fake = await new FakeDaemon().start();
    fake.add(snapshot({ ctrlState: 'guardstop', opMode: 'MANR', speedRatio: 25, collision: 'TRIGGERED', level: 'degraded', quality: 'stale' }));
    h = await harness({ fake });
    const s = structured(await h.call('summarize_controller', { sourceLine: false }));
    expect(s.facts.map((f: { code: string }) => f.code)).toEqual([
      'GUARD_STOP', 'COLLISION_TRIGGERED', 'MANUAL_MODE', 'SPEED_BELOW_100', 'LINK_NOT_CURRENT', 'NO_PROBLEMS_IN_WINDOW',
    ]);
    expect(s.state).toBe('Guard stop, manual mode, reduced speed, program stopped.');
  });
});

describe('this server\'s time is taken after the last read', () => {
  it('a slow module read: the text is never later than now, and its age is not negative', async () => {
    h = await withController(stoppedCell().snap);
    h.fake.overrides.push(slowModules(1600, 200, { task: 'T_ROB1', module: 'MainModule', kind: 'program', text: MAIN_MODULE, changeCount: 3 }));
    const r = await h.call('read_rapid_source', { task: 'T_ROB1', module: 'MainModule', aroundLine: 9 });
    const s = structured(r);
    expect(s.fromCache).toBe(false);
    expect(Date.parse(s.now)).toBeGreaterThanOrEqual(Date.parse(s.readAt));
    expect(s.ageS).toBeGreaterThanOrEqual(0);
    expect(text(r)).not.toContain("ahead of this server's clock");

    // The summary reads the same module slowly too, on a server with an empty cache.
    await h.close();
    h = await withController(stoppedCell().snap);
    h.fake.overrides.push(slowModules(1600, 200, { task: 'T_ROB1', module: 'MainModule', kind: 'program', text: MAIN_MODULE, changeCount: 3 }));
    const sum = structured(await h.call('summarize_controller', {}));
    expect(Date.parse(sum.now)).toBeGreaterThanOrEqual(Date.parse(sum.controllerData.tasks[0].pp.sourceReadAt));
  });
});

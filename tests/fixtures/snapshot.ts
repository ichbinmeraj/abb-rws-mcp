/**
 * Synthetic daemon answers of schema 0.14, built relative to a base time.
 * tests/fixtures.test.ts validates every builder's output against the
 * daemon's own JSON Schema (tests/fixtures/schema/v0.14.schema.json), so the
 * fake daemon cannot drift from the real shapes. Every name and text here is
 * made up for the tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export const iso = (t: number): string => new Date(t).toISOString();

/** The controller's clock reading without a zone, as RobotWare reports it. */
const rawClock = (t: number): string => new Date(t).toISOString().slice(0, 19).replace('T', ' T ');

export interface EventSpec {
  seq: number;
  code: number | null;
  severity: 'info' | 'warning' | 'error' | null;
  title: string;
  ageS: number;
  description?: string | null;
  causes?: string | null;
  consequences?: string | null;
  actions?: string | null;
  args?: { type: string; value: string }[];
  corrected?: boolean;
  backlog?: boolean;
  titleFromCode?: boolean;
}

export function event(now: number, e: EventSpec): Json {
  const t = now - e.ageS * 1000;
  const corrected = e.corrected ?? true;
  return {
    seq: e.seq,
    seqnum: 1000 + e.seq,
    code: e.code,
    severity: e.severity,
    title: e.title,
    titleFromCode: e.titleFromCode ?? false,
    description: e.description === undefined ? 'A synthetic description. It has a second sentence.' : e.description,
    causes: e.causes === undefined ? null : e.causes,
    consequences: e.consequences === undefined ? null : e.consequences,
    actions: e.actions === undefined ? null : e.actions,
    args: e.args ?? [],
    source: 'MC0',
    time: { raw: rawClock(corrected ? t : t + 2 * 3600_000), utc: iso(corrected ? t : t + 2 * 3600_000), corrected },
    receivedAt: iso(e.backlog ? now - 3600_000 : t + 50),
    backlog: e.backlog ?? false,
  };
}

const JOINT_LIMITS: [number, number][] = [[-180, 180], [-90, 150], [-180, 75], [-400, 400], [-125, 120], [-400, 400]];

export function joints(values: number[]): Json[] {
  return values.map((v, i) => ({ name: `J${i + 1}`, value: v, unit: 'deg', min: JOINT_LIMITS[i][0], max: JOINT_LIMITS[i][1] }));
}

export interface SnapOptions {
  id?: string;
  name?: string;
  now?: number;
  virtual?: boolean | null;
  rw?: [number, number];
  quality?: 'live' | 'polling' | 'reconnecting' | 'stale' | 'disconnected';
  level?: 'current' | 'degraded' | 'down' | 'wrong-controller';
  mode?: 'live' | 'replay';
  ctrlState?: string | null;
  opMode?: string | null;
  speedRatio?: number | null;
  collision?: string | null;
  execState?: 'running' | 'stopped' | null;
  watching?: boolean;
  motionAgeS?: number | null;
  jointValues?: number[];
  events?: Json[];
}

export function snapshot(o: SnapOptions = {}): Json {
  const now = o.now ?? Date.now();
  const at = iso(now - 200);
  const level = o.level ?? 'current';
  const quality = o.quality ?? (level === 'down' ? 'disconnected' : 'live');
  const healthy = quality === 'live' || quality === 'polling';
  const mismatch = level === 'wrong-controller';
  const down = level === 'down';
  const [major, minor] = o.rw ?? [7, 21];
  const groupState = (g: string): { group: string; state: string; asOf: string | null; reason: string | null } => {
    if (mismatch) { return { group: g, state: 'withheld', asOf: null, reason: 'the link answers as a different controller' }; }
    if (g === 'motion') { return { group: g, state: o.watching ? 'current' : 'idle', asOf: o.motionAgeS === null ? null : iso(now - (o.motionAgeS ?? 30) * 1000), reason: o.watching ? null : 'no watch lease' }; }
    if (g === 'io') { return { group: g, state: 'idle', asOf: null, reason: 'no watch lease' }; }
    if (down) { return { group: g, state: 'stale', asOf: iso(now - 360_000), reason: 'the link is down' }; }
    if (level === 'degraded' && g === 'rapid') { return { group: g, state: 'stale', asOf: iso(now - 192_000), reason: 'the last read failed' }; }
    return { group: g, state: 'current', asOf: at, reason: null };
  };
  const events = o.events ?? [];
  return {
    id: o.id ?? 'cell-1',
    name: o.name ?? 'Cell 1',
    identity: mismatch ? null : {
      controllerName: 'VC-CELL1',
      controllerId: 'synthetic-controller-id',
      controllerType: o.virtual === false ? 'Real Controller' : 'Virtual Controller',
      virtual: o.virtual === undefined ? true : o.virtual,
      mac: null,
      systemName: 'CellOne',
      sysId: '{00000000-0000-0000-0000-000000000001}',
      startTime: '2026-10-20 T 08:00:00',
      robotWare: { raw: `${major}.${minor}.0+100`, major, minor, generation: major >= 7 ? 'rws2' : 'rws1' },
      options: ['Option A', 'Option B'],
      asOf: at,
    },
    link: {
      connected: healthy || quality === 'stale',
      quality,
      qualityReason: healthy ? '' : 'connection refused',
      since: iso(now - (down ? 360_000 : 3_600_000)),
      downSince: healthy && level !== 'degraded' ? null : iso(now - (down ? 360_000 : 192_000)),
      host: '127.0.0.1',
      port: 80,
      useHttps: false,
      subscriptions: { active: healthy },
      identityCheck: { status: mismatch ? 'mismatch' : 'confirmed', expected: '{x}', actual: mismatch ? '{y}' : '{x}' },
      reconnect: down ? { failures: 3, nextAttemptAt: iso(now + 5000) } : null,
      mode: o.mode ?? 'live',
      recordedAt: o.mode === 'replay' ? iso(now - 86_400_000) : null,
    },
    panel: {
      ctrlState: o.ctrlState === undefined ? 'motoron' : o.ctrlState,
      opMode: o.opMode === undefined ? 'AUTO' : o.opMode,
      speedRatio: o.speedRatio === undefined ? 100 : o.speedRatio,
      collisionDetection: o.collision === undefined ? 'INIT' : o.collision,
      asOf: down ? iso(now - 361_000) : at,
    },
    rapid: {
      execState: o.execState === undefined ? 'stopped' : o.execState,
      cycle: 'forever',
      tasks: [{
        name: 'T_ROB1', type: 'NORMAL', taskState: 'linked', execState: o.execState === undefined ? 'stopped' : o.execState,
        active: true, motion: true, modules: ['MainModule', 'BASE', 'user'],
        pp: { module: 'MainModule', routine: 'pick', line: 9 },
        mp: { module: 'MainModule', routine: 'pick', line: 8 },
      }],
      asOf: at,
    },
    motion: {
      watching: o.watching ?? false,
      units: [{
        name: 'ROB_1', kind: 'robot', typeRaw: 'TCPRobot', task: 'T_ROB1',
        joints: joints(o.jointValues ?? [0, 10, 20, 0, 30, 0]),
        pose: { x: 900, y: 0, z: 1200, q: [0.70710678, 0, 0.70710678, 0], tool: 'tool0', wobj: 'wobj0', coord: 'Base' },
        error: null,
      }],
      rate: { targetHz: o.watching ? 8 : null, achievedHz: o.watching ? 7.9 : null, via: o.watching ? 'poll' : null },
      asOf: o.motionAgeS === null ? null : iso(now - (o.motionAgeS ?? 30) * 1000),
    },
    io: {
      watching: false,
      signals: [],
      asOf: null,
    },
    events: {
      feed: mismatch ? null : 'feed-aaaa1111',
      lastSeq: events.length ? Math.max(...events.map((e: Json) => e.seq)) : 0,
      recent: events.slice(-20),
      via: healthy ? 'subscription' : null,
      clock: { offsetMs: -7_200_000, measuredAt: at, problem: null },
      asOf: at,
      error: null,
    },
    access: {
      generation: major >= 8 ? 'rw8' : major === 7 ? 'rw7' : 'rw6',
      model: major >= 8 ? 'writeaccess' : 'mastership',
      locks: (major >= 8 ? ['writeaccess'] : major === 7 ? ['edit', 'motion'] : ['cfg', 'motion', 'rapid']).map(lock => ({
        lock, held: false, holder: null, heldByDaemon: false, reported: major >= 8 ? null : 'nomaster', asOf: at, error: null,
      })),
      remoteAccessEnabled: major >= 8 ? true : null,
      rmmp: { supported: major >= 8 ? false : true, privilege: major >= 8 ? null : 'none', asOf: major >= 8 ? null : at, error: null },
      via: healthy ? 'poll' : null,
      problem: null,
      asOf: at,
    },
    capabilities: {
      protocol: major >= 7 ? 'rws2' : 'rws1',
      generation: major >= 8 ? 'rw8' : major === 7 ? 'rw7' : 'rw6',
      robotWare: `${major}.${minor}.0+100`,
      tested: true,
      entries: ['status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp']
        .map(id => ({ id, state: 'available', reason: null })),
      asOf: at,
    },
    freshness: {
      level,
      reasons: level === 'current' ? [] : [down ? 'the link is down: connection refused' : 'rapid: the last read failed'],
      groups: ['identity', 'panel', 'rapid', 'motion', 'io', 'events', 'access'].map(groupState),
    },
  };
}

/**
 * The first lock held by the FlexPendant, as schema 0.14 says it (flexPendant
 * true): a station named FlexPendant on RobotWare 8, a local holder whose
 * application is TPU on RobotWare 7.
 */
export function pendantHolds(snap: Json): Json {
  const rw8 = snap.access.generation === 'rw8';
  const lock = snap.access.locks[0];
  lock.held = true;
  lock.holder = rw8
    ? { kind: 'station', name: 'FlexPendant', application: null, flexPendant: true }
    : { kind: 'local', name: null, application: 'TPU', flexPendant: true };
  if (!rw8) { lock.reported = 'local'; }
  return snap;
}

export function health(o: { now?: number; mode?: 'live' | 'replay'; recording?: boolean; startedAt?: string } = {}): Json {
  const now = o.now ?? Date.now();
  return {
    status: 'ok',
    version: '0.1.0',
    startedAt: o.startedAt ?? iso(now - 7_200_000),
    uptimeS: 7200,
    mode: o.mode ?? 'live',
    recording: { active: o.recording ?? false, since: o.recording ? iso(now - 60_000) : null },
    replay: o.mode === 'replay'
      ? { state: 'playing', positionMs: 1000, durationMs: 60_000, speed: 1, loop: true, loops: 0, recordedAt: iso(now - 86_400_000), time: 'shifted' }
      : null,
  };
}

/** The RAPID module of the stopped-cell fixture: line 9 is the WaitDI the task stopped on. */
export const MAIN_MODULE = [
  'MODULE MainModule',
  '  CONST robtarget pHome := [[900,0,1200],[0.7071068,0,0.7071068,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];',
  '  PROC main()',
  '    pick;',
  '    place;',
  '  ENDPROC',
  '  PROC pick()',
  '    MoveJ pHome, v1000, z50, tool0;',
  '    WaitDI diPartPresent, 1 \\MaxTime:=5;',
  '    MoveL Offs(pHome,0,0,-100), v200, fine, tool0;',
  '  ENDPROC',
  '  FUNC num twice(num x)',
  '    RETURN 2 * x;',
  '  ENDFUNC',
  '  TRAP onStop',
  '    TPWrite "stopped";',
  '  ENDTRAP',
  'ENDMODULE',
].join('\n');

/** The stopped-cell fixture of the demo: RW 7.21 VC, motors on, automatic, program stopped at the WaitDI. */
export function stoppedCell(now = Date.now()): { snap: Json; events: Json[] } {
  const events = [
    event(now, { seq: 1, code: 10011, severity: 'info', title: 'Motors ON state', ageS: 600, description: 'The system is in the Motors ON state.' }),
    event(now, { seq: 2, code: 10052, severity: 'info', title: 'Regain start', ageS: 590 }),
    event(now, { seq: 3, code: 50024, severity: 'warning', title: 'Corner path failure', ageS: 7200, actions: 'Check the zone data.' }),
    event(now, { seq: 4, code: 41000, severity: 'error', title: 'Synthetic RAPID error: WaitDI timed out', ageS: 40,
      description: 'The task stopped at a WaitDI that timed out. The input did not reach the value in time.',
      causes: 'The input stayed at 0.', actions: 'Check the part sensor and the signal diPartPresent. Then restart the program.' }),
    event(now, { seq: 5, code: 10002, severity: 'info', title: 'Program stopped', ageS: 39 }),
  ];
  return { snap: snapshot({ now, events, execState: 'stopped' }), events };
}

export function signalTable(): Json[] {
  return [
    { name: 'diPartPresent', type: 'DI', value: '0' },
    { name: 'diDoorClosed', type: 'DI', value: '1' },
    { name: 'doGripperClose', type: 'DO', value: '0' },
    { name: 'aiPressure', type: 'AI', value: '4.25' },
  ];
}

import { z } from 'zod';
import { cleanDeep } from '../clean.js';
import type { Context, LeaseOutcome } from '../context.js';
import { LEASE_ID, NEW_LEASE, answerError, errorBody } from '../daemon.js';
import { eulerZyxFromQuaternion } from '../euler.js';
import { ageS, parseTime, validTime, when } from '../render.js';
import { MotionWatchAnswer, type Motion, type Snapshot } from '../schema.js';
import {
  ANNOTATIONS, DESCRIPTION_TAIL, blockOf, commonShape, controllerInput, dataText, header, ok, reasons, refreshed, scoped, type Scoped,
} from './common.js';

export const NAME = 'get_robot_position';
export const DESCRIPTION = 'Joint positions and the TCP pose of each mechanical unit, whether the arm is moving, and how close each joint is to its limits.'
  + ' To return current values, this tool may ask the daemon to sample joint positions and the pose for 15 s. Those are controller'
  + ' reads (8 joint reads a second per mechanical unit, 2 pose reads a second per robot). The person can turn this off.'
  + DESCRIPTION_TAIL;

export const INPUT = {
  controller: controllerInput,
  unit: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional().describe('Only this mechanical unit in the answer (e.g. ROB_1). The daemon samples every unit either way.'),
  fresh: z.boolean().optional().describe('Ask the daemon to sample now when nobody does (default true).'),
};

/** The daemon's motion lease length. */
export const LEASE_MS = 15_000;
const POLL_MS = 250;
// The daemon samples an RWS 1.0 controller at under 1 Hz (0.8 Hz seen on RobotWare 6.16), and its
// first sample after a new lease came about 3.5 s after the request. Wait long enough for that,
// and for a second sample at that rate, so a slow controller answers on the first call too.
const FIRST_SAMPLE_MS = 6_000;
const SECOND_SAMPLE_MS = 2_000;
/** A joint change larger than this (deg or mm) between two samples counts as moving. */
export const MOVING_THRESHOLD = 0.01;
/** Within this share of the range at either end counts as near a limit. */
export const NEAR_LIMIT_SHARE = 0.02;

const BUSY_CODES = new Set(['RATE_LIMITED', 'CONTROLLER_BUSY', 'SESSION_EXPIRED']);

const JointOut = z.object({
  name: z.string(), value: z.number().nullable(), unit: z.enum(['deg', 'mm']).nullable(),
  min: z.number().nullable(), max: z.number().nullable(), percentOfRange: z.number().nullable(), nearLimit: z.boolean().nullable(),
});

const UnitOut = z.object({
  index: z.number(),
  kind: z.enum(['robot', 'positioner', 'external']).nullable(),
  joints: z.array(JointOut),
  pose: z.object({
    x: z.number(), y: z.number(), z: z.number(),
    q: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    eulerZyxDeg: z.object({ rx: z.number(), ry: z.number(), rz: z.number() }).nullable(),
    gimbalLock: z.boolean(),
  }).nullable(),
  moving: z.union([z.boolean(), z.literal('unknown')]),
  maxJointRate: z.object({ value: z.number(), unit: z.enum(['deg/s', 'mm/s']) }).nullable(),
  errorCode: z.string().nullable(),
});

export const OUTPUT = z.object({
  ...commonShape,
  units: z.array(UnitOut),
  motion: z.object({
    watching: z.boolean(), targetHz: z.number().nullable(), achievedHz: z.number().nullable(),
    asOf: z.string().nullable(), ageS: z.number().nullable(),
  }),
  sampledBy: z.enum(['this-server', 'another-consumer', 'nobody']),
  samplingRequested: z.boolean(),
  heldBack: z.string().nullable(),
  controllerData: z.object({
    units: z.array(z.object({
      index: z.number(), name: z.string(), typeRaw: z.string().nullable(), task: z.string().nullable(),
      tool: z.string().nullable(), wobj: z.string().nullable(), coord: z.string().nullable(), error: z.string().nullable(),
    })),
    freshnessReasons: z.array(z.string()),
    linkReason: z.string().nullable(),
    groupReasons: z.array(z.object({ group: z.string(), reason: z.string() })),
  }),
});

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Why no lease request was made (fixed text), or null when one may be made. */
function guard(ctx: Context, snap: Snapshot, fresh: boolean): string | null {
  if (!fresh) { return 'Sampling was not asked for (fresh: false).'; }
  if (!ctx.config.motionSampling) { return 'Motion sampling is turned off for this server.'; }
  const l = snap.link;
  if ((l.mode ?? 'live') !== 'live' || (l.quality !== 'live' && l.quality !== 'polling') || l.identityCheck.status === 'mismatch') {
    return 'The link is not live, so no sampling was requested.';
  }
  if (snap.freshness.level !== 'current') { return "The controller's data is not current, so no sampling was requested."; }
  const codes = [
    ...snap.motion.units.map(u => u.error?.code),
    snap.events.error?.code,
    ...snap.access.locks.map(k => k.error?.code),
    snap.access.rmmp.error?.code,
    ...snap.io.signals.map(x => x.error?.code),
  ];
  if (codes.some(c => c !== undefined && BUSY_CODES.has(c))) {
    return 'The controller reported that it is busy or rate-limited, so no sampling was requested.';
  }
  return null;
}

/** Ask the daemon for one lease on this controller (at most one per 15 s, joined by concurrent calls). */
async function requestLease(ctx: Context, s: Scoped): Promise<LeaseOutcome> {
  const book = ctx.leases;
  const startedAt = s.ready.health.startedAt;
  if (book.leaseFor !== null && book.leaseFor !== startedAt) {
    // The daemon restarted: its leases are gone, so the next request opens a new one.
    book.leaseId = null;
    book.leaseFor = null;
  }
  while (book.opening) { await book.opening; }
  const opensNew = book.leaseId === null;
  let done: () => void = () => {};
  if (opensNew) { book.opening = new Promise<void>(r => { done = r; }); }
  try {
    const postedAt = ctx.now();
    const ans = await ctx.daemon.motionWatch(s.id, book.leaseId ?? NEW_LEASE);
    if (ans.status === 200) {
      const grant = MotionWatchAnswer.safeParse(ans.body);
      if (grant.success && grant.data.leaseId !== undefined && LEASE_ID.test(grant.data.leaseId)) {
        book.leaseId = grant.data.leaseId;
        book.leaseFor = startedAt;
      }
      return { kind: 'granted', postedAt };
    }
    if (ans.status === 429 && errorBody(ans.body).code === 'LEASE_LIMIT') { return { kind: 'lease-limit' }; }
    throw answerError(ans, s.ready.ids);
  } finally {
    if (opensNew) { book.opening = null; done(); }
  }
}

/** The snapshot again, until `motion.asOf` is later than `after` or the time is up. */
async function waitForSample(ctx: Context, s: Scoped, after: number, withinMs: number): Promise<Snapshot | null> {
  const end = ctx.now() + withinMs;
  while (ctx.now() < end) {
    await sleep(POLL_MS);
    const snap = await ctx.snapshot(s.ready, s.id);
    const t = parseTime(snap.motion.asOf);
    if (t !== null && t > after) { return snap; }
  }
  return null;
}

type Sample = { motion: Motion; at: number };

function sampleOf(snap: Snapshot): Sample | null {
  const t = parseTime(snap.motion.asOf);
  return t === null ? null : { motion: snap.motion, at: t };
}

export async function getRobotPosition(ctx: Context, args: { controller?: string; unit?: string; fresh?: boolean }): Promise<ReturnType<typeof ok>> {
  const s = await scoped(ctx, args.controller);
  let snap = s.snap;
  const fresh = args.fresh ?? true;
  let heldBack = guard(ctx, snap, fresh);
  let samplingRequested = false;
  let sampledBy: 'this-server' | 'another-consumer' | 'nobody' = snap.motion.watching ? 'another-consumer' : 'nobody';
  const book = ctx.leases;
  const mine = book.perController.get(s.id) ?? { lastRequestAt: -Infinity, expiresAt: -Infinity, postedAt: -Infinity, inflight: null };
  book.perController.set(s.id, mine);
  if (mine.expiresAt > ctx.now()) { sampledBy = 'this-server'; }
  let first: Sample | null = sampleOf(snap);
  let second: Sample | null = null;

  if (heldBack === null) {
    const recent = first !== null && ctx.now() - first.at < 1_000;
    if (mine.inflight) {
      // Another call is asking already: join it.
      const outcome = await mine.inflight;
      if (outcome.kind === 'granted') { samplingRequested = true; sampledBy = 'this-server'; }
      const got = await waitForSample(ctx, s, outcome.kind === 'granted' ? outcome.postedAt : (first?.at ?? 0), FIRST_SAMPLE_MS);
      if (got) { snap = got; first = sampleOf(got); }
    } else if (snap.motion.watching) {
      // Someone samples already (another consumer, or this server's lease still runs): no request, wait for newer samples.
      const got = await waitForSample(ctx, s, first?.at ?? 0, SECOND_SAMPLE_MS);
      if (got) { second = sampleOf(got); snap = got; }
    } else if (recent) {
      heldBack = 'The positions were read less than 1 s ago.';
    } else if (ctx.now() - mine.lastRequestAt < LEASE_MS) {
      heldBack = 'This server asked for sampling on this controller less than 15 s ago.';
    } else {
      mine.lastRequestAt = ctx.now();
      const p = requestLease(ctx, s);
      mine.inflight = p;
      let outcome: LeaseOutcome;
      try { outcome = await p; } finally { mine.inflight = null; }
      if (outcome.kind === 'granted') {
        samplingRequested = true;
        sampledBy = 'this-server';
        mine.postedAt = outcome.postedAt;
        mine.expiresAt = outcome.postedAt + LEASE_MS;
        const got = await waitForSample(ctx, s, outcome.postedAt, FIRST_SAMPLE_MS);
        if (got) {
          snap = got;
          first = sampleOf(got);
          const next = await waitForSample(ctx, s, first!.at, SECOND_SAMPLE_MS);
          if (next) { snap = next; second = sampleOf(next); }
        }
      } else if (outcome.kind === 'lease-limit') {
        heldBack = 'The daemon holds the most watch leases it allows; the last values are shown.';
      }
    }
  }
  // This server's time after the last snapshot read: waiting for samples takes seconds, and no age may come out negative.
  return render(ctx, { ...refreshed(ctx, s), snap }, args.unit, first, second, sampledBy, samplingRequested, heldBack);
}

function render(
  ctx: Context, s: Scoped, unitFilter: string | undefined, first: Sample | null, second: Sample | null,
  sampledBy: 'this-server' | 'another-consumer' | 'nobody', samplingRequested: boolean, heldBack: string | null,
): ReturnType<typeof ok> {
  const { snap, now } = s;
  const { common, lines: head } = header(s, ['motion']);
  const m = snap.motion;
  const units = m.units
    .map((u, index) => ({ u, index }))
    .filter(({ u }) => unitFilter === undefined || u.name.toLowerCase() === unitFilter.toLowerCase());

  const outUnits = units.map(({ u, index }) => {
    const joints = u.joints.map(j => {
      const unit = j.unit === 'deg' || j.unit === 'mm' ? j.unit : null;
      const range = j.min !== null && j.max !== null && j.max > j.min ? j.max - j.min : null;
      const pct = range !== null && j.value !== null ? Math.round(((j.value - j.min!) / range) * 1000) / 10 : null;
      const near = range !== null && j.value !== null
        ? (j.value - j.min!) <= NEAR_LIMIT_SHARE * range || (j.max! - j.value) <= NEAR_LIMIT_SHARE * range : null;
      return { name: /^[JE][1-6]$/.test(j.name) ? j.name : 'unknown', value: j.value, unit, min: j.min, max: j.max, percentOfRange: pct, nearLimit: near };
    });
    const e = u.pose ? eulerZyxFromQuaternion(u.pose.q) : null;
    const pose = u.pose ? {
      x: u.pose.x, y: u.pose.y, z: u.pose.z, q: u.pose.q,
      eulerZyxDeg: e ? { rx: e.rx, ry: e.ry, rz: e.rz } : null,
      gimbalLock: e?.gimbalLock ?? false,
    } : null;
    // Moving: from two samples of the same unit.
    let moving: boolean | 'unknown' = 'unknown';
    let maxJointRate: { value: number; unit: 'deg/s' | 'mm/s' } | null = null;
    if (first && second && second.at > first.at) {
      const a = first.motion.units.find(x => x.name === u.name);
      const b = second.motion.units.find(x => x.name === u.name);
      if (a && b) {
        const dt = (second.at - first.at) / 1000;
        let anyKnown = false;
        moving = false;
        for (const jb of b.joints) {
          const ja = a.joints.find(x => x.name === jb.name);
          if (!ja || ja.value === null || jb.value === null) { continue; }
          anyKnown = true;
          const d = Math.abs(jb.value - ja.value);
          if (d > MOVING_THRESHOLD) { moving = true; }
          const rate = Math.round((d / dt) * 1000) / 1000;
          if ((jb.unit === 'deg' || jb.unit === 'mm') && (maxJointRate === null || rate > maxJointRate.value)) {
            maxJointRate = { value: rate, unit: jb.unit === 'deg' ? 'deg/s' : 'mm/s' };
          }
        }
        if (!anyKnown) { moving = 'unknown'; maxJointRate = null; }
      }
    }
    const kind = u.kind === 'robot' || u.kind === 'positioner' || u.kind === 'external' ? u.kind : null;
    return { index, kind, joints, pose, moving, maxJointRate, errorCode: u.error && /^[A-Z][A-Z0-9_]{0,39}$/.test(u.error.code) ? u.error.code : null };
  });

  const rs = reasons(snap, ['motion']);
  const controllerData = cleanDeep({
    units: units.map(({ u, index }) => ({
      index, name: u.name, typeRaw: u.typeRaw, task: u.task,
      tool: u.pose?.tool ?? null, wobj: u.pose?.wobj ?? null, coord: u.pose?.coord ?? null, error: u.error?.message ?? null,
    })),
    ...rs,
  });
  const out = {
    ...common,
    units: outUnits,
    motion: {
      watching: m.watching, targetHz: m.rate.targetHz, achievedHz: m.rate.achievedHz,
      asOf: validTime(m.asOf), ageS: ageS(m.asOf, now),
    },
    sampledBy,
    samplingRequested,
    heldBack,
    controllerData,
  };
  if (out.motion.ageS !== null && out.motion.ageS > 5) { out.stale = true; }

  const t = [...head];
  t.push(m.asOf
    ? `Positions as of ${when(m.asOf, now)}${out.motion.ageS !== null && out.motion.ageS > 5 ? ' (STALE)' : ''}; ${m.watching ? `sampled at ${m.rate.achievedHz ?? m.rate.targetHz ?? '?'} Hz` : 'nobody is sampling now'}.`
    : 'Positions: never sampled on this connection.');
  t.push(samplingRequested ? 'This server asked the daemon to sample for 15 s.' : (heldBack ? `No sampling was requested: ${heldBack}` : (sampledBy === 'another-consumer' ? 'Another program is sampling; no request was needed.' : '')));
  t.push('Joint values in deg (revolute) or mm (linear) as given; a joint with no unit is unknown, do not convert. Pose in mm, in the frame named by coord;'
    + ' Euler angles ZYX in degrees; q is [w, x, y, z]. The pose is read at a quarter of the joint rate, so it can be older than the joints.');
  if (units.length === 0) { t.push(unitFilter ? 'No mechanical unit with that name.' : 'No mechanical unit is listed yet.'); }
  for (const u of outUnits) {
    const parts = [`Unit ${u.index} (${u.kind ?? 'kind unknown'}): moving ${u.moving === 'unknown' ? 'unknown (one sample or none)' : u.moving ? 'YES' : 'no'}`
      + `${u.maxJointRate ? `, fastest joint ${u.maxJointRate.value} ${u.maxJointRate.unit}` : ''}${u.errorCode ? `, last read failed (${u.errorCode})` : ''}.`];
    if (u.joints.length) {
      parts.push(`  Joints: ${u.joints.map(j => `${j.name} ${j.value ?? '?'}${j.unit ? ` ${j.unit}` : ''}${j.percentOfRange !== null ? ` (${j.percentOfRange} % of range${j.nearLimit ? ', NEAR LIMIT' : ''})` : ''}`).join(', ')}.`);
    }
    if (u.pose) {
      parts.push(`  TCP: x ${u.pose.x}, y ${u.pose.y}, z ${u.pose.z} mm; q [${u.pose.q.join(', ')}]`
        + `${u.pose.eulerZyxDeg ? `; Euler ZYX rx ${u.pose.eulerZyxDeg.rx}, ry ${u.pose.eulerZyxDeg.ry}, rz ${u.pose.eulerZyxDeg.rz} deg${u.pose.gimbalLock ? ' (gimbal lock: rx set to 0)' : ''}` : ''}.`);
    }
    t.push(...parts);
  }
  t.push('Unit names, tasks, tools, work objects and frames, by unit index:');
  t.push(blockOf(s.nonce, dataText({ units: controllerData.units }, now),
    rs.freshnessReasons.length || rs.linkReason || rs.groupReasons.length ? dataText(rs, now) : ''));
  return ok(t.filter(x => x !== '').join('\n'), out);
}

export const annotations = ANNOTATIONS;

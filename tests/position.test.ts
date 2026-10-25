import { afterEach, describe, expect, it } from 'vitest';
import { FakeDaemon, sampleOnRead } from './fakeDaemon.js';
import { snapshot } from './fixtures/snapshot.js';
import { allAllowed, harness, structured, text, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const posts = (fake: FakeDaemon) => fake.log.filter(r => r.method === 'POST');

async function cell(opts: Parameters<typeof snapshot>[0] = {}, harnessOpts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const fake = await new FakeDaemon().start();
  fake.add(snapshot({ motionAgeS: 30, ...opts }));
  // The lease makes the fake sample from then on, moving each joint 0.5 deg per read.
  fake.onLease = id => { if (!fake.controllers.get(id).motion.watching) { sampleOnRead(fake, id, 0.5); } };
  return harness({ fake, ...harnessOpts });
}

describe('get_robot_position: the lease', () => {
  it('10 concurrent fresh calls give exactly one POST, with "new" and a body', async () => {
    h = await cell();
    const results = await Promise.all(Array.from({ length: 10 }, () => h!.call('get_robot_position', {})));
    for (const r of results) { expect(r.isError, text(r)).toBeFalsy(); }
    const p = posts(h.fake);
    expect(p).toHaveLength(1);
    expect(JSON.parse(p[0].body!)).toEqual({ leaseId: 'new' });
    expect(p[0].url).toBe('/v0/controllers/cell-1/motion/watch');
    expect(results.some(r => structured(r).samplingRequested)).toBe(true);
    expect(allAllowed(h.fake)).toBe(true);
  });

  it('a second call within 15 s sends none; the returned lease id is used after the first', async () => {
    h = await cell();
    const a = await h.call('get_robot_position', {});
    expect(structured(a).sampledBy).toBe('this-server');
    expect(structured(a).units[0].moving).toBe(true);
    expect(structured(a).units[0].maxJointRate.unit).toBe('deg/s');
    // The samples arrive after the lease: this server's time is taken after them, so no age is negative.
    expect(structured(a).motion.ageS).toBeGreaterThanOrEqual(0);
    expect(Date.parse(structured(a).now)).toBeGreaterThanOrEqual(Date.parse(structured(a).motion.asOf));
    expect(text(a)).not.toContain("ahead of this server's clock");
    const b = await h.call('get_robot_position', {});
    expect(b.isError).toBeFalsy();
    expect(posts(h.fake)).toHaveLength(1);
    // A second controller: the id the daemon returned, not "new".
    h.fake.add(snapshot({ id: 'cell-2', motionAgeS: 30 }));
    await new Promise(r => setTimeout(r, 10));
    h.ctx.daemon.invalidate();
    const c = await h.call('get_robot_position', { controller: 'cell-2' });
    expect(c.isError, text(c)).toBeFalsy();
    const p = posts(h.fake);
    expect(p).toHaveLength(2);
    expect(JSON.parse(p[1].body!)).toEqual({ leaseId: 'lease-1' });
  });

  it('no POST on a degraded link, a fresh asOf, fresh: false or sampling off', async () => {
    h = await cell({ level: 'degraded', quality: 'stale' });
    const r = await h.call('get_robot_position', {});
    expect(structured(r).heldBack).toMatch(/not live/);
    expect(posts(h.fake)).toHaveLength(0);
    await h.close();

    h = await cell({ motionAgeS: 0 });
    expect(structured(await h.call('get_robot_position', {})).heldBack).toMatch(/less than 1 s ago/);
    expect(structured(await h.call('get_robot_position', { fresh: false })).heldBack).toMatch(/fresh: false/);
    expect(posts(h.fake)).toHaveLength(0);
    await h.close();

    h = await cell({}, { motionSampling: false });
    const off = await h.call('get_robot_position', {});
    expect(structured(off).heldBack).toMatch(/turned off/);
    expect(structured(off).sampledBy).toBe('nobody');
    expect(text(off)).toContain('Positions as of');
    expect(posts(h.fake)).toHaveLength(0);
  });

  it('no POST when the controller reports a busy code on an error object', async () => {
    const s = snapshot({ motionAgeS: 30 });
    s.events.error = { code: 'RATE_LIMITED', message: 'slow down' };
    const fake = await new FakeDaemon().start();
    fake.add(s);
    h = await harness({ fake });
    const r = await h.call('get_robot_position', {});
    expect(structured(r).heldBack).toMatch(/busy or rate-limited/);
    expect(posts(fake)).toHaveLength(0);
  });

  it('another consumer samples: no POST, two samples give moving', async () => {
    h = await cell({ watching: true, motionAgeS: 0 });
    sampleOnRead(h.fake, 'cell-1', 0);
    const r = await h.call('get_robot_position', {});
    expect(structured(r).sampledBy).toBe('another-consumer');
    expect(structured(r).units[0].moving).toBe(false);
    expect(posts(h.fake)).toHaveLength(0);
  });

  it('429 LEASE_LIMIT is not an error: the last values come back with a note', async () => {
    h = await cell();
    h.fake.overrides.push((req, res) => {
      if (req.method !== 'POST') { return false; }
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '15' });
      res.end(JSON.stringify({ error: 'too many leases', code: 'LEASE_LIMIT' }));
      return true;
    });
    const r = await h.call('get_robot_position', {});
    expect(r.isError).toBeFalsy();
    expect(structured(r).heldBack).toMatch(/most watch leases/);
    expect(structured(r).units[0].joints).toHaveLength(6);
  });
});

describe('get_robot_position: values', () => {
  it('nearLimit, percentOfRange and units', async () => {
    h = await cell({ jointValues: [179, 0, 0, 0, 0, 0] }, { motionSampling: false });
    const u = structured(await h.call('get_robot_position', {})).units[0];
    expect(u.joints[0]).toMatchObject({ name: 'J1', value: 179, unit: 'deg', nearLimit: true, percentOfRange: 99.7 });
    expect(u.joints[1].nearLimit).toBe(false);
    expect(u.pose.eulerZyxDeg).toEqual({ rx: 0, ry: 90, rz: 0 });
    expect(u.pose.gimbalLock).toBe(true);
    expect(u.moving).toBe('unknown');
  });

  it('a unit filter and an unknown unit', async () => {
    h = await cell({}, { motionSampling: false });
    expect(structured(await h.call('get_robot_position', { unit: 'rob_1' })).units).toHaveLength(1);
    const none = await h.call('get_robot_position', { unit: 'ROB_9' });
    expect(structured(none).units).toHaveLength(0);
    expect(text(none)).toContain('No mechanical unit with that name.');
  });
});

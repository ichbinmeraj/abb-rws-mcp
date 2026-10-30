import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ModuleCache, MODULE_CACHE_MAX_BYTES, MODULE_CACHE_MS } from '../src/cache.js';
import { ConfigError, defaultTokenPath, parseArgs, parseDaemonUrl } from '../src/config.js';
import { schemaStatus } from '../src/context.js';
import { eulerZyxFromQuaternion, quaternionFromEulerZyx } from '../src/euler.js';
import { ReadLimiter } from '../src/limits.js';
import { addSecret, createLogger, mask, safeValue } from '../src/log.js';
import { COLLISION, CTRL_STATE, CYCLE, meaning } from '../src/meanings.js';
import { duration, when } from '../src/render.js';
import { categoryOf, passes } from '../src/tools/eventsCommon.js';
import { SERVER_VERSION } from '../src/version.js';

describe('options and variables', () => {
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/x/.cfg' };

  it('defaults: 127.0.0.1:7810, the daemon token file, sampling on, replay off, warn', () => {
    const p = parseArgs([], env, 'linux');
    expect(p).toEqual({ kind: 'run', config: {
      port: 7810, hostHeader: '127.0.0.1:7810', tokenFile: '/home/x/.cfg/abb-rws-daemon/token',
      allowReplay: false, motionSampling: true, logLevel: 'warn', markCodesFile: null,
    } });
    expect(defaultTokenPath(env, 'win32')).toBe('C:\\Users\\x\\AppData\\Roaming\\abb-rws-daemon\\token');
    expect(defaultTokenPath({}, 'linux', () => '/home/y')).toBe('/home/y/.config/abb-rws-daemon/token');
  });

  it('an option wins over its variable; an empty variable is unset', () => {
    const p = parseArgs(['--daemon-url', 'http://localhost:7811', '--motion-sampling=off', '--allow-replay', '--token-file', '/t'],
      { ABB_RWS_MCP_DAEMON_URL: 'http://127.0.0.1:9999', ABB_RWS_MCP_MOTION_SAMPLING: 'on', ABB_RWS_MCP_LOG: '' }, 'linux');
    expect(p).toMatchObject({ config: { port: 7811, hostHeader: 'localhost:7811', motionSampling: false, allowReplay: true, tokenFile: '/t', logLevel: 'warn' } });
    expect(parseArgs([], { ABB_RWS_MCP_ALLOW_REPLAY: '1', ABB_RWS_DAEMON_TOKEN_FILE: '/d/token', ABB_RWS_MCP_LOG: 'debug' }, 'linux'))
      .toMatchObject({ config: { allowReplay: true, tokenFile: '/d/token', logLevel: 'debug' } });
    expect(parseArgs(['--help'], {}, 'linux')).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'], {}, 'linux')).toEqual({ kind: 'version' });
  });

  it('refuses every other daemon URL and bad values', () => {
    for (const u of ['https://127.0.0.1:7810', 'http://[::1]:7810', 'http://192.168.0.5:7810', 'http://127.0.0.1', 'http://user@127.0.0.1:7810',
      'http://127.0.0.1:7810/v0', 'http://127.0.0.1:7810?x', 'http://127.0.0.1:7810#f', 'http://127.0.0.2:7810', 'http://localhost.example.com:7810',
      'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://2130706433:7810']) {
      expect(() => parseDaemonUrl(u), u).toThrow(ConfigError);
    }
    expect(parseDaemonUrl('http://127.0.0.1:7810/')).toEqual({ port: 7810, hostHeader: '127.0.0.1:7810' });
    expect(() => parseArgs(['--motion-sampling', 'maybe'], {}, 'linux')).toThrow(ConfigError);
    expect(() => parseArgs(['--remote'], {}, 'linux')).toThrow(ConfigError);
    expect(() => parseArgs([], { ABB_RWS_MCP_LOG: 'loud' }, 'linux')).toThrow(ConfigError);
    expect(() => parseArgs(['--daemon-url'], {}, 'linux')).toThrow(ConfigError);
  });
});

describe('logging', () => {
  it('masks the token and reduces field values to a safe set', () => {
    addSecret('secret-token-value-0123456789abcdef');
    expect(mask('x secret-token-value-0123456789abcdef y')).toBe('x [token] y');
    expect(safeValue('a b\nc"d')).toBe('a?b?c?d');
    const lines: string[] = [];
    const log = createLogger('info', l => lines.push(l));
    log.debug('hidden');
    log.info('shown', { route: '/v0/controllers/:id', token: 'secret-token-value-0123456789abcdef' });
    expect(lines).toEqual(['abb-rws-mcp info shown route=/v0/controllers/:id token=[token]\n']);
  });
});

describe('limits and cache', () => {
  it('one in flight, a bucket of two, one more every 2 s', () => {
    let t = 0;
    const l = new ReadLimiter(() => t);
    const a = l.take('c');
    expect(a.ok).toBe(true);
    expect(l.take('c')).toEqual({ ok: false, retryAfterS: 1 });
    if (a.ok) { a.release(); }
    const b = l.take('c');
    if (b.ok) { b.release(); }
    expect(l.take('c')).toEqual({ ok: false, retryAfterS: 2 });
    expect(l.take('other').ok).toBe(true);
    t = 2000;
    const c = l.take('c');
    expect(c.ok).toBe(true);
    if (c.ok) { c.release(); }
    expect(l.take('c').ok).toBe(false);
  });

  it('module text: 60 s, dropped when the module list changes, 8 MiB in all', () => {
    let t = 0;
    const c = new ModuleCache(() => t);
    const k = ModuleCache.key('c', 's', 'T_ROB1', 'M');
    c.set(k, 'sig', { text: 'abc', kind: 'program', changeCount: 1, readAt: 0 });
    expect(c.get(k, 'sig')?.text).toBe('abc');
    expect(c.get(k, 'other-sig')).toBeNull();
    c.set(k, 'sig', { text: 'abc', kind: 'program', changeCount: 1, readAt: 0 });
    t = MODULE_CACHE_MS;
    expect(c.get(k, 'sig')).toBeNull();
    t = 0;
    const big = 'x'.repeat(MODULE_CACHE_MAX_BYTES / 2 / 2 - 10);
    for (let i = 0; i < 5; i++) { c.set(ModuleCache.key('c', 's', 'T', `M${i}`), 'sig', { text: big, kind: null, changeCount: null, readAt: 0 }); }
    expect(c.totalBytes).toBeLessThanOrEqual(MODULE_CACHE_MAX_BYTES);
    expect(c.get(ModuleCache.key('c', 's', 'T', 'M0'), 'sig')).toBeNull();
    expect(c.get(ModuleCache.key('c', 's', 'T', 'M4'), 'sig')).not.toBeNull();
  });
});

describe('Euler angles (ZYX, as RAPID EulerZYX)', () => {
  it('known rotations', () => {
    expect(eulerZyxFromQuaternion([1, 0, 0, 0])).toEqual({ rx: 0, ry: 0, rz: 0, gimbalLock: false });
    const z90 = eulerZyxFromQuaternion([Math.SQRT1_2, 0, 0, Math.SQRT1_2])!;
    expect([z90.rx, z90.ry, z90.rz]).toEqual([0, 0, 90]);
    const x90 = eulerZyxFromQuaternion([Math.SQRT1_2, Math.SQRT1_2, 0, 0])!;
    expect([x90.rx, x90.ry, x90.rz]).toEqual([90, 0, 0]);
    const y45 = eulerZyxFromQuaternion([Math.cos(Math.PI / 8), 0, Math.sin(Math.PI / 8), 0])!;
    expect([y45.rx, y45.ry, y45.rz]).toEqual([0, 45, 0]);
    // A typical tool-down pose: q = [0, 0, 1, 0] is a 180 deg turn about y.
    const down = eulerZyxFromQuaternion([0, 0, 1, 0])!;
    expect(Math.abs(down.rx)).toBe(180);
    expect(down.ry).toBe(0);
    expect(Math.abs(down.rz)).toBe(180);
    expect(eulerZyxFromQuaternion([0, 0, 0, 0])).toBeNull();
    expect(eulerZyxFromQuaternion([Number.NaN, 0, 0, 0])).toBeNull();
  });

  it('round trips, a non-unit quaternion, and gimbal lock at ry = +-90', () => {
    for (const [rx, ry, rz] of [[10, 20, 30], [-170, 45, 100], [5, -80, -120], [0, 0, -179]]) {
      const e = eulerZyxFromQuaternion(quaternionFromEulerZyx(rx, ry, rz))!;
      expect(e.rx).toBeCloseTo(rx, 3);
      expect(e.ry).toBeCloseTo(ry, 3);
      expect(e.rz).toBeCloseTo(rz, 3);
    }
    const scaled = quaternionFromEulerZyx(10, 20, 30).map(v => v * 3) as [number, number, number, number];
    expect(eulerZyxFromQuaternion(scaled)!.rz).toBeCloseTo(30, 3);
    const lock = eulerZyxFromQuaternion(quaternionFromEulerZyx(25, 90, 60))!;
    expect(lock.gimbalLock).toBe(true);
    expect(lock.rx).toBe(0);
    expect(lock.ry).toBe(90);
    // Only rz - rx is defined at ry = 90: with rx set to 0, rz carries it.
    expect(lock.rz).toBeCloseTo(35, 3);
    const back = quaternionFromEulerZyx(lock.rx, lock.ry, lock.rz);
    const orig = quaternionFromEulerZyx(25, 90, 60);
    const dot = Math.abs(back.reduce((s, v, i) => s + v * orig[i], 0));
    expect(dot).toBeCloseTo(1, 6);
    expect(eulerZyxFromQuaternion(quaternionFromEulerZyx(0, -90, 10))!).toMatchObject({ ry: -90, gimbalLock: true });
  });
});

describe('meanings, categories, times, schema, version', () => {
  it('known values have a sentence, unknown ones say so', () => {
    expect(meaning(CTRL_STATE, 'guardstop')).toMatch(/safety circuit/);
    expect(meaning(CTRL_STATE, 'flying')).toBe('not a known value');
    expect(meaning(CTRL_STATE, null)).toBe('not read yet');
    expect(meaning(COLLISION, 'TRIGGERED_ACK')).toMatch(/ABB does not describe/);
    expect(meaning(CYCLE, 'asis')).toMatch(/shown as reported/);
  });

  it('event categories follow ABB numbering; null severity passes every filter', () => {
    expect(categoryOf(10011)).toBe('operational');
    expect(categoryOf(120003)).toBe('configuration');
    expect(categoryOf(90210)).toBe('safety');
    expect(categoryOf(170001)).toBe('connected-services');
    expect(categoryOf(60001)).toBeNull();
    expect(categoryOf(9999)).toBeNull();
    expect(categoryOf(null)).toBeNull();
    expect(passes('other', 'error')).toBe(true);
    expect(passes('info', 'warning')).toBe(false);
  });

  it('times and ages', () => {
    const now = Date.parse('2026-10-20T14:05:23Z');
    expect(when('2026-10-20T14:02:11Z', now)).toBe('14:02:11 UTC (3 min 12 s ago)');
    expect(when('2026-10-19T09:12:00Z', now)).toBe('2026-10-19 09:12:00 UTC (1 d 4 h ago)');
    expect(when('garbage', now)).toBe('an unreadable time');
    expect(when(null, now)).toBe('no time');
    expect(duration(7260)).toBe('2 h 1 min');
  });

  it('schema versions', () => {
    expect(schemaStatus('0.13')).toBe('tested');
    expect(schemaStatus('0.14')).toBe('tested');
    expect(schemaStatus('0.15')).toBe('tested');
    expect(schemaStatus('0.16')).toBe('untested-newer');
    expect(schemaStatus('0.12')).toBe('unsupported');
    expect(schemaStatus('1.0')).toBe('unsupported');
    expect(schemaStatus('x')).toBe('unsupported');
  });

  it('the server version is the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

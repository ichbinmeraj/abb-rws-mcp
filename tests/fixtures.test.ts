import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { event, health, pendantHolds, snapshot, stoppedCell } from './fixtures/snapshot.js';

// The daemon's own JSON Schema of 0.14, the one abb-rws-daemon 0.1.0 serves,
// copied from its schema/history with the sha256 its history/index.json pins.
const SCHEMA_PATH = new URL('./fixtures/schema/v0.14.schema.json', import.meta.url);
const SCHEMA_SHA256 = '733c0eeec9ce7b0b91cc1d02eaec76b9aa12e2c9a0855281aa27c2824cb22d1c';

const text = readFileSync(SCHEMA_PATH, 'utf8');
const schema = JSON.parse(text);
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
ajv.addSchema(schema, 'v0');
const validate = (def: string, value: unknown): string[] => {
  const v = ajv.getSchema(`v0#/definitions/${def}`)!;
  return v(value) ? [] : (v.errors ?? []).map(e => `${e.instancePath} ${e.message}`);
};

describe('fixtures follow the daemon schema 0.14', () => {
  it('the copied schema is the released 0.14 file', () => {
    expect(createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')).toBe(SCHEMA_SHA256);
    expect(schema['x-schema-version']).toBe('0.14');
  });

  it('every snapshot builder makes a valid ControllerSnapshot', () => {
    const now = Date.now();
    const cases = [
      snapshot(), snapshot({ level: 'down' }), snapshot({ level: 'degraded', quality: 'stale' }), snapshot({ level: 'wrong-controller' }),
      snapshot({ mode: 'replay' }), snapshot({ rw: [6, 16], virtual: false }), snapshot({ rw: [8, 2], watching: true, motionAgeS: 0 }),
      snapshot({ ctrlState: null, opMode: null, execState: null, speedRatio: null, collision: null, motionAgeS: null }),
      stoppedCell(now).snap, pendantHolds(snapshot({ rw: [8, 2] })), pendantHolds(snapshot({ rw: [7, 21] })),
    ];
    for (const c of cases) { expect(validate('ControllerSnapshot', c)).toEqual([]); }
  });

  it('events, health and lists are valid', () => {
    const now = Date.now();
    for (const e of stoppedCell(now).events) { expect(validate('ControllerEvent', e)).toEqual([]); }
    expect(validate('ControllerEvent', event(now, { seq: 9, code: null, severity: null, title: 'Event 0', ageS: 1, corrected: false, backlog: true, titleFromCode: true }))).toEqual([]);
    expect(validate('HealthAnswer', health())).toEqual([]);
    expect(validate('HealthAnswer', health({ mode: 'replay', recording: true }))).toEqual([]);
    expect(validate('ControllerList', { schemaVersion: '0.14', observedAt: new Date(now).toISOString(), controllers: [snapshot()] })).toEqual([]);
    expect(validate('EventsPage', { feed: 'f', firstSeq: 1, lastSeq: 5, gap: false, more: false, events: stoppedCell(now).events })).toEqual([]);
    expect(validate('RapidModuleSource', { task: 'T_ROB1', module: 'MainModule', kind: 'program', text: 'MODULE x\nENDMODULE', changeCount: 3 })).toEqual([]);
    expect(validate('MotionWatch', { leaseMs: 15000, targetHz: 8, leaseId: 'lease-1' })).toEqual([]);
  });
});

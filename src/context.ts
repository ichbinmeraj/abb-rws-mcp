import { z } from 'zod';
import { ModuleCache } from './cache.js';
import type { Config } from './config.js';
import { answerError, type DaemonClient } from './daemon.js';
import { ID_PATTERN, errors } from './errors.js';
import { ReadLimiter } from './limits.js';
import type { Logger } from './log.js';
import { ControllerListHead, parseAnswer, Snapshot, type Health } from './schema.js';
import { SCHEMA_OLDEST, SCHEMA_TESTED } from './version.js';

/**
 * What every tool shares: the configuration, the daemon client, this
 * server's limits, the module cache and the lease book, and the checks every
 * controller-scoped call makes first (health, schema, replay, which
 * controller).
 */

export type SchemaStatus = 'tested' | 'untested-newer' | 'unsupported';

/** 'tested' from SCHEMA_OLDEST to SCHEMA_TESTED, 'untested-newer' for a later minor of the same major. */
export function schemaStatus(version: string): SchemaStatus {
  const m = /^([0-9]{1,4})\.([0-9]{1,4})$/.exec(version);
  if (!m) { return 'unsupported'; }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== SCHEMA_TESTED.major || minor < SCHEMA_OLDEST.minor) { return 'unsupported'; }
  return minor <= SCHEMA_TESTED.minor ? 'tested' : 'untested-newer';
}

export interface Ready {
  health: Health;
  schema: SchemaStatus;
  /** The schema version the daemon reported (`major.minor`, checked by schemaStatus). */
  schemaVersion: string;
  /** The controller ids the daemon serves, those that match its id pattern. */
  ids: string[];
}

/** Lease bookkeeping of get_robot_position. */
export interface LeaseBook {
  /** The lease id the daemon returned to this process, and the daemon start it belongs to. */
  leaseId: string | null;
  leaseFor: string | null;
  /** A request with "new" in flight: everyone else waits for its id. */
  opening: Promise<void> | null;
  perController: Map<string, { lastRequestAt: number; expiresAt: number; postedAt: number; inflight: Promise<LeaseOutcome> | null }>;
}

export type LeaseOutcome =
  | { kind: 'granted'; postedAt: number }
  | { kind: 'lease-limit' }
  | { kind: 'refused' };

const IdOnly = z.object({ id: z.string() });

export class Context {
  readonly limiter: ReadLimiter;
  readonly cache: ModuleCache;
  readonly leases: LeaseBook = { leaseId: null, leaseFor: null, opening: null, perController: new Map() };
  private schemaCache: { health: Health; at: number; status: SchemaStatus; version: string; ids: string[] } | null = null;
  private warnedNewer = false;

  constructor(
    readonly config: Config,
    readonly daemon: DaemonClient,
    readonly log: Logger,
    readonly now: () => number = Date.now,
  ) {
    this.limiter = new ReadLimiter(now);
    this.cache = new ModuleCache(now);
  }

  /**
   * Health (no older than 10 s) and the schema version from `GET /v0/controllers`
   * (cached as long as that health answer). Throws DAEMON_UNREACHABLE,
   * NOT_A_DAEMON, TOKEN_* or SCHEMA_UNSUPPORTED.
   */
  async readyWithoutReplayCheck(): Promise<Ready> {
    const health = await this.daemon.health();
    const c = this.schemaCache;
    if (c && c.health === health && this.now() - c.at < 10_000) {
      if (c.status === 'unsupported') { throw errors.schemaUnsupported(c.version, health.mode === 'replay'); }
      return { health, schema: c.status, schemaVersion: c.version, ids: c.ids };
    }
    const ans = await this.daemon.get('controllers');
    if (ans.status !== 200) { throw answerError(ans); }
    const head = parseAnswer(ControllerListHead, ans.body, 'controllers');
    const status = schemaStatus(head.schemaVersion);
    const ids: string[] = [];
    if (status !== 'unsupported') {
      for (const c of head.controllers) {
        const r = IdOnly.safeParse(c);
        if (r.success && ID_PATTERN.test(r.data.id)) { ids.push(r.data.id); }
      }
    }
    if (status === 'untested-newer' && !this.warnedNewer) {
      this.warnedNewer = true;
      this.log.warn('schema.untested-newer', { tested: `${SCHEMA_TESTED.major}.${SCHEMA_TESTED.minor}` });
    }
    this.schemaCache = { health: this.daemon.cachedHealth() ?? health, at: this.now(), status, version: head.schemaVersion, ids };
    if (status === 'unsupported') { throw errors.schemaUnsupported(head.schemaVersion, health.mode === 'replay'); }
    return { health, schema: status, schemaVersion: head.schemaVersion, ids };
  }

  /** As readyWithoutReplayCheck, and REPLAY_REFUSED when the daemon replays and replay is not allowed. */
  async ready(): Promise<Ready> {
    const r = await this.readyWithoutReplayCheck();
    if (r.health.mode === 'replay' && !this.config.allowReplay) { throw errors.replayRefused(); }
    return r;
  }

  /** The controller to read: the one named, or the only one the daemon has. */
  resolve(ready: Ready, controller: string | undefined): string {
    if (controller !== undefined) {
      if (!ID_PATTERN.test(controller)) { throw errors.unknownController(ready.ids); }
      return controller;
    }
    if (ready.ids.length === 1) { return ready.ids[0]; }
    throw errors.controllerRequired(ready.ids);
  }

  /** `GET /v0/controllers/:id`, parsed; WRONG_CONTROLLER for a link on another controller; REPLAY_REFUSED for a replayed link. */
  async snapshot(ready: Ready, id: string): Promise<Snapshot> {
    const ans = await this.daemon.get('controller', { id });
    if (ans.status !== 200) { throw answerError(ans, ready.ids); }
    const snap = parseAnswer(Snapshot, ans.body, 'snapshot');
    if (snap.link.identityCheck.status === 'mismatch' || snap.freshness.level === 'wrong-controller') {
      throw errors.wrongController();
    }
    if (snap.link.mode === 'replay' && !this.config.allowReplay) { throw errors.replayRefused(); }
    return snap;
  }
}

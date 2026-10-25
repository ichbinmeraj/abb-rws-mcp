import http from 'node:http';
import { ID_PATTERN, ToolError, errors, CODE_PATTERN } from './errors.js';
import { addSecret, type Logger } from './log.js';
import { ErrorBodySchema, Health, type ErrorBody } from './schema.js';
import { readTokenFile, TokenFileError } from './token.js';

/**
 * The only module that sends a request, and the only `node:http` user. It
 * talks to the daemon on the literal 127.0.0.1 and to nothing else, and it
 * sends only the requests of the read-only table below: before anything is
 * sent, the method, the path, every query key and value and the body are
 * checked against it, and anything else throws. There is no generic request
 * function: `get` takes a route name from the table, `motionWatch` sends the
 * one POST, a motion watch lease, which the daemon documents as sampling.
 *
 * The token goes out only to 127.0.0.1, only after a token-less
 * `GET /v0/health` on the same origin, within the last 10 s, answered with the
 * daemon's shape; after any connection error that check runs again first. The
 * header is set here, at send time; no object that holds it reaches a logger.
 */

export const RAPID_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const LEASE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const NEW_LEASE = 'new';
export const TOKEN_HEADER = 'x-abb-rws-token';

/** The largest answer read: 16 MiB. */
export const ANSWER_MAX = 16 * 1024 * 1024;
export const HEALTH_DEADLINE_MS = 2_000;
export const REQUEST_DEADLINE_MS = 10_000;
/** How long a health answer (and the right to send the token) lasts. */
export const HEALTH_CACHE_MS = 10_000;

export const EVENTS_PAGE_MAX = 256;
const FILTER_MAX = 160;

type Param = 'id' | 'task' | 'module';
type QuerySpec = { kind: 'int'; min: number; max: number } | { kind: 'text'; max: number };

interface RouteSpec {
  template: string;
  pattern: RegExp;
  params: readonly Param[];
  query: Readonly<Record<string, QuerySpec>>;
  token: boolean;
}

const route = (template: string, params: readonly Param[], query: Record<string, QuerySpec>, token = true): RouteSpec => ({
  template,
  pattern: new RegExp(`^${template.replace(/:(id|task|module)/g, '([^/?#]+)')}$`),
  params,
  query,
  token,
});

/** The read-only route table: every GET this server can send. */
export const ROUTES = {
  health: route('/v0/health', [], {}, false),
  controllers: route('/v0/controllers', [], {}),
  controller: route('/v0/controllers/:id', ['id'], {}),
  events: route('/v0/controllers/:id/events', ['id'], {
    since: { kind: 'int', min: 0, max: Number.MAX_SAFE_INTEGER },
    limit: { kind: 'int', min: 1, max: EVENTS_PAGE_MAX },
  }),
  signals: route('/v0/controllers/:id/io/signals', ['id'], {
    name: { kind: 'text', max: FILTER_MAX },
    device: { kind: 'text', max: FILTER_MAX },
    network: { kind: 'text', max: FILTER_MAX },
    category: { kind: 'text', max: FILTER_MAX },
    type: { kind: 'text', max: 16 },
  }),
  module: route('/v0/controllers/:id/rapid/tasks/:task/modules/:module', ['id', 'task', 'module'], {}),
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/** The one POST: a motion watch lease. Its body is exactly `{ "leaseId": <id> }`. */
export const MOTION_WATCH = route('/v0/controllers/:id/motion/watch', ['id'], {});

const PARAM_PATTERN: Record<Param, RegExp> = { id: ID_PATTERN, task: RAPID_NAME, module: RAPID_NAME };

/** A request outside the table: a bug in this server, never sent. */
export class RefusedRequestError extends Error {
  constructor(why: string) {
    super(`request refused before sending: ${why}`);
    this.name = 'RefusedRequestError';
  }
}

function checkQueryValue(key: string, spec: QuerySpec, value: string): boolean {
  if (spec.kind === 'int') {
    if (!/^[0-9]{1,16}$/.test(value)) { return false; }
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= spec.min && n <= spec.max;
  }
  return value.length <= spec.max && key.length > 0;
}

/**
 * Whether a request is one of the table's: the method, the path (each
 * parameter matching its pattern), every query key and value, and the body.
 * Used before every send, and by the tests on every request the fake daemon
 * receives.
 */
export function isAllowedRequest(method: string, pathAndQuery: string, body: string | null): boolean {
  let url: URL;
  try { url = new URL(pathAndQuery, 'http://127.0.0.1'); } catch { return false; }
  if (url.origin !== 'http://127.0.0.1' || url.hash || url.username || url.password) { return false; }
  const matchParams = (spec: RouteSpec): boolean => {
    const m = spec.pattern.exec(url.pathname);
    if (!m) { return false; }
    return spec.params.every((p, i) => {
      let v: string;
      try { v = decodeURIComponent(m[i + 1]); } catch { return false; }
      return PARAM_PATTERN[p].test(v) && encodeURIComponent(v) === m[i + 1];
    });
  };
  if (method === 'POST') {
    if (!matchParams(MOTION_WATCH) || url.search !== '' || body === null) { return false; }
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length === 1 && typeof (parsed as { leaseId?: unknown }).leaseId === 'string'
        && LEASE_ID.test((parsed as { leaseId: string }).leaseId);
    } catch { return false; }
  }
  if (method !== 'GET' || body !== null) { return false; }
  for (const spec of Object.values(ROUTES) as RouteSpec[]) {
    if (!matchParams(spec)) { continue; }
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) { return false; }
    return keys.every(k => {
      const q = spec.query[k];
      return q !== undefined && checkQueryValue(k, q, url.searchParams.get(k)!);
    });
  }
  return false;
}

/** The path of a table route, every parameter checked and encoded, the query built with URLSearchParams. */
export function buildPath(name: RouteName, params: Partial<Record<Param, string>> = {}, query: Record<string, string | number | undefined> = {}): string {
  const spec: RouteSpec = ROUTES[name];
  let path = spec.template;
  for (const p of spec.params) {
    const v = params[p];
    if (v === undefined || !PARAM_PATTERN[p].test(v)) { throw new RefusedRequestError(`${p} does not match its pattern`); }
    path = path.replace(`:${p}`, encodeURIComponent(v));
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) { continue; }
    const q = spec.query[k];
    if (!q || !checkQueryValue(k, q, String(v))) { throw new RefusedRequestError(`query ${k} is not allowed here`); }
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** A daemon answer: its status, its Retry-After in whole seconds (or null) and its parsed JSON body. */
export interface Answer {
  status: number;
  retryAfterS: number | null;
  body: unknown;
}

export interface DaemonOptions {
  port: number;
  hostHeader: string;
  tokenFile: string;
  log: Logger;
  readToken?: (path: string) => Promise<string>;
  now?: () => number;
  /** Deadlines (tests): health and every other request. */
  healthDeadlineMs?: number;
  requestDeadlineMs?: number;
}

class Deadline extends Error {}

const noLookup = (_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void): void => {
  cb(new Error('this server makes no DNS lookup'), '', 4);
};

export class DaemonClient {
  readonly port: number;
  private readonly hostHeader: string;
  private readonly tokenFile: string;
  private readonly log: Logger;
  private readonly readToken: (path: string) => Promise<string>;
  private readonly now: () => number;
  private readonly healthDeadlineMs: number;
  private readonly requestDeadlineMs: number;
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  private readonly inflight = new Map<string, Promise<Answer>>();
  private healthCache: { at: number; health: Health } | null = null;
  private healthInflight: Promise<Health> | null = null;
  private token: string | null = null;
  private tokenFor: string | null = null;
  private tokenInflight: Promise<string> | null = null;
  /** The token state of the last attempt, for list_controllers. */
  tokenState: 'ok' | 'unreadable' | 'refused' | 'unknown' = 'unknown';

  constructor(opts: DaemonOptions) {
    this.port = opts.port;
    this.hostHeader = opts.hostHeader;
    this.tokenFile = opts.tokenFile;
    this.log = opts.log;
    this.readToken = opts.readToken ?? ((p: string): Promise<string> => readTokenFile(p));
    this.now = opts.now ?? Date.now;
    this.healthDeadlineMs = opts.healthDeadlineMs ?? HEALTH_DEADLINE_MS;
    this.requestDeadlineMs = opts.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  }

  close(): void {
    this.agent.destroy();
  }

  /** Forget the health answer: the next token request checks health again. */
  invalidate(): void {
    this.healthCache = null;
  }

  /**
   * The daemon's health, from a token-less `GET /v0/health` no older than
   * 10 s. Throws DAEMON_UNREACHABLE, or NOT_A_DAEMON when the answer is not
   * the daemon's shape.
   */
  async health(): Promise<Health> {
    const c = this.healthCache;
    if (c && this.now() - c.at < HEALTH_CACHE_MS) { return c.health; }
    if (this.healthInflight) { return this.healthInflight; }
    const run = (async (): Promise<Health> => {
      const ans = await this.send('GET', ROUTES.health.template, '/v0/health', null, false, this.healthDeadlineMs);
      if (ans.status === 421) { throw errors.hostRefused(); }
      const parsed = Health.safeParse(ans.body);
      if (ans.status !== 200 || !parsed.success) {
        this.healthCache = null;
        throw errors.notADaemon(this.port);
      }
      const health = parsed.data;
      if (this.tokenFor !== null && this.tokenFor !== health.startedAt) {
        // The daemon restarted: read the token again before the next request.
        this.token = null;
      }
      this.healthCache = { at: this.now(), health };
      return health;
    })();
    this.healthInflight = run;
    try { return await run; } finally { this.healthInflight = null; }
  }

  /** The cached health without a request, or null. */
  cachedHealth(): Health | null {
    return this.healthCache?.health ?? null;
  }

  private async currentToken(force: boolean): Promise<string> {
    if (this.token !== null && !force) { return this.token; }
    if (this.tokenInflight) { return this.tokenInflight; }
    const run = (async (): Promise<string> => {
      try {
        const t = await this.readToken(this.tokenFile);
        addSecret(t);
        this.token = t;
        this.tokenFor = this.healthCache?.health.startedAt ?? null;
        return t;
      } catch (e) {
        this.tokenState = 'unreadable';
        this.log.warn('token.unreadable', { reason: e instanceof TokenFileError ? e.reason : 'unreadable' });
        this.log.debugPath('token.file', this.tokenFile);
        throw errors.tokenUnreadable();
      }
    })();
    this.tokenInflight = run;
    try { return await run; } finally { this.tokenInflight = null; }
  }

  /** GET a table route. Token routes check health first and re-read the token once after a 401. */
  async get(name: RouteName, params: Partial<Record<Param, string>> = {}, query: Record<string, string | number | undefined> = {}): Promise<Answer> {
    const spec: RouteSpec = ROUTES[name];
    const path = buildPath(name, params, query);
    if (!spec.token) { return this.shared(`n ${path}`, () => this.send('GET', spec.template, path, null, false, this.requestDeadlineMs)); }
    return this.shared(`t ${path}`, () => this.withToken(() => this.send('GET', spec.template, path, null, true, this.requestDeadlineMs)));
  }

  /** `POST /v0/controllers/:id/motion/watch` with `{ leaseId }`: a motion watch lease, which the daemon documents as sampling. */
  async motionWatch(id: string, leaseId: string): Promise<Answer> {
    if (!ID_PATTERN.test(id)) { throw new RefusedRequestError('id does not match its pattern'); }
    if (!LEASE_ID.test(leaseId)) { throw new RefusedRequestError('leaseId does not match its pattern'); }
    const path = MOTION_WATCH.template.replace(':id', encodeURIComponent(id));
    const body = JSON.stringify({ leaseId });
    return this.withToken(() => this.send('POST', MOTION_WATCH.template, path, body, true, this.requestDeadlineMs));
  }

  private async shared(key: string, run: () => Promise<Answer>): Promise<Answer> {
    const existing = this.inflight.get(key);
    if (existing) { return existing; }
    const p = run();
    this.inflight.set(key, p);
    try { return await p; } finally { this.inflight.delete(key); }
  }

  private async withToken(send: () => Promise<Answer>): Promise<Answer> {
    await this.health();
    await this.currentToken(false);
    let ans = await send();
    if (ans.status === 401 && isTokenRefusal(ans.body)) {
      await this.currentToken(true);
      await this.health();
      ans = await send();
      if (ans.status === 401 && isTokenRefusal(ans.body)) {
        this.tokenState = 'refused';
        throw errors.tokenRefused();
      }
    }
    if (ans.status === 421) { throw errors.hostRefused(); }
    this.tokenState = 'ok';
    return ans;
  }

  private send(method: 'GET' | 'POST', template: string, path: string, body: string | null, withToken: boolean, deadlineMs: number): Promise<Answer> {
    if (!isAllowedRequest(method, path, body)) { return Promise.reject(new RefusedRequestError(`${method} ${template}`)); }
    if (withToken && (this.token === null || this.healthCache === null)) {
      return Promise.reject(new RefusedRequestError('the token goes out only after a health check'));
    }
    const started = this.now();
    return new Promise<Answer>((resolve, reject) => {
      let settled = false;
      let res: http.IncomingMessage | null = null;
      const headers: Record<string, string> = { host: this.hostHeader, accept: 'application/json' };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      if (withToken) { headers[TOKEN_HEADER] = this.token!; }
      const req = http.request({
        host: '127.0.0.1',
        family: 4,
        port: this.port,
        method,
        path,
        agent: this.agent,
        headers,
        lookup: noLookup as unknown as http.RequestOptions['lookup'],
      });
      const finish = (err: Error | null, ans?: Answer): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        const ms = this.now() - started;
        if (err) {
          if (!(err instanceof ToolError)) {
            this.invalidate();
            this.log.debug('request', { method, route: template, result: 'no-answer', ms });
            reject(errors.daemonUnreachable(this.port));
            return;
          }
          this.log.debug('request', { method, route: template, result: err.code, ms });
          reject(err);
          return;
        }
        this.log.debug('request', { method, route: template, status: ans!.status, ms });
        resolve(ans!);
      };
      const timer = setTimeout(() => {
        const e = new Deadline('deadline');
        finish(e);
        res?.destroy(e);
        req.destroy(e);
      }, deadlineMs);
      req.on('error', e => finish(e));
      req.on('response', r => {
        res = r;
        const status = r.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          finish(errors.redirect());
          r.destroy();
          req.destroy();
          return;
        }
        const length = Number(r.headers['content-length']);
        if (Number.isFinite(length) && length > ANSWER_MAX) {
          finish(errors.tooLarge());
          r.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size > ANSWER_MAX) {
            finish(errors.tooLarge());
            r.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        r.on('error', e => finish(e));
        r.on('aborted', () => finish(new Error('aborted')));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          if (text.trim() !== '') {
            try { parsed = JSON.parse(text); } catch { finish(errors.unexpected()); return; }
          }
          finish(null, { status, retryAfterS: retryAfter(r.headers['retry-after']), body: parsed });
        });
      });
      if (body !== null) { req.write(body); }
      req.end();
    });
  }
}

function retryAfter(value: string | string[] | undefined): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined || !/^[0-9]{1,5}$/.test(v.trim())) { return null; }
  return Math.min(3600, Number(v.trim()));
}

function isTokenRefusal(body: unknown): boolean {
  const code = (body as { code?: unknown } | null)?.code;
  return code === 'TOKEN_MISSING' || code === 'TOKEN_INVALID';
}

/** The daemon's error body, or an empty one. */
export function errorBody(body: unknown): ErrorBody {
  const r = ErrorBodySchema.safeParse(body);
  return r.success ? r.data : {};
}

const UNAVAILABLE = new Set(['NOT_CONNECTED', 'SESSION_EXPIRED', 'CONTROLLER_BUSY', 'RATE_LIMITED', 'NETWORK_ERROR']);

/**
 * The tool error for a failed answer. `knownIds` fills the list
 * of UNKNOWN_CONTROLLER; NOT_FOUND gets its names from the caller.
 */
export function answerError(ans: Answer, knownIds: readonly string[] = []): ToolError {
  const body = errorBody(ans.body);
  const code = body.code ?? '';
  const retry = Math.max(1, ans.retryAfterS ?? 2);
  if (ans.status === 404 && code === 'NO_CONTROLLER') { return errors.unknownController(knownIds); }
  if (ans.status === 409 && code === 'IDENTITY_MISMATCH') { return errors.wrongController(); }
  if (ans.status === 503 && code === 'NOT_READY') { return errors.notReady(retry); }
  if (ans.status === 429 && code === 'READ_LIMIT') { return errors.busy(retry); }
  if (ans.status === 404 && (code === 'RESOURCE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'NOT_RECORDED')) {
    return errors.notFound('task, module or routine');
  }
  if (UNAVAILABLE.has(code) && (ans.status === 503 || ans.status === 504)) { return errors.controllerUnavailable(code); }
  if (ans.status === 500 && code === 'DAEMON_ERROR') { return errors.daemonError(); }
  if (ans.status === 421) { return errors.hostRefused(); }
  if (ans.status >= 400) {
    const data: Record<string, unknown> = {};
    if (body.controller) { data.controller = body.controller; }
    if (typeof body.refusal?.missing === 'string') { data.refusal = { missing: body.refusal.missing }; }
    return errors.controllerError(CODE_PATTERN.test(code) ? code : null, Object.keys(data).length ? data : undefined);
  }
  return errors.unexpected();
}

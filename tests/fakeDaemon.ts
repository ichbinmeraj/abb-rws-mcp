/**
 * A fake abb-rws-daemon on node:http, for the offline tests. It serves the
 * read routes from fixtures, checks the token like the daemon, keeps a log of
 * every request it receives, and can be told to answer a route otherwise
 * (status, Retry-After, a redirect, an oversized or trickled body).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { health as healthFixture, iso, type Json } from './fixtures/snapshot.js';

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string | null;
}

export type Override = (req: Received, res: http.ServerResponse) => boolean;

export class FakeDaemon {
  server: http.Server;
  port = 0;
  token = 'fake-token-0123456789-abcdefghijklmnopqrstuvwxyz';
  schemaVersion = '0.14';
  health: Json = healthFixture();
  controllers = new Map<string, Json>();
  events = new Map<string, Json[]>();
  signals = new Map<string, Json[]>();
  /** Search answers by controller; default: the table filtered by the query. */
  search?: (id: string, query: URLSearchParams) => Json[];
  /** Module texts by `${id}/${task}/${module}`. */
  modules = new Map<string, string>();
  log: Received[] = [];
  overrides: Override[] = [];
  /** Lease ids handed out. */
  leaseCounter = 0;
  /** When a motion lease is granted: what the motion group becomes on later reads. */
  onLease?: (id: string) => void;

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
        const r: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
        this.log.push(r);
        for (const o of this.overrides) { if (o(r, res)) { return; } }
        this.route(r, res);
      });
    });
  }

  async start(host = '127.0.0.1'): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(0, host, resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  add(snap: Json, events: Json[] = [], signals: Json[] = []): void {
    this.controllers.set(snap.id, snap);
    this.events.set(snap.id, events);
    this.signals.set(snap.id, signals);
  }

  /** Requests other than GET /v0/health. */
  tokenRequests(): Received[] {
    return this.log.filter(r => !r.url.startsWith('/v0/health'));
  }

  private send(res: http.ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  }

  private route(r: Received, res: http.ServerResponse): void {
    const url = new URL(r.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (r.method === 'GET' && path === '/v0/health') { this.send(res, 200, this.health); return; }
    const tok = r.headers['x-abb-rws-token'];
    if (tok === undefined) { this.send(res, 401, { error: 'token missing', code: 'TOKEN_MISSING' }); return; }
    if (tok !== this.token) { this.send(res, 401, { error: 'token invalid', code: 'TOKEN_INVALID' }); return; }
    if (r.method === 'GET' && path === '/v0/controllers') {
      this.send(res, 200, { schemaVersion: this.schemaVersion, observedAt: iso(Date.now()), controllers: [...this.controllers.values()] });
      return;
    }
    const m = /^\/v0\/controllers\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) { this.send(res, 404, { error: 'no route', code: 'NO_ROUTE' }); return; }
    const id = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';
    const snap = this.controllers.get(id);
    if (!snap) { this.send(res, 404, { error: `no controller with id "${id}"`, code: 'NO_CONTROLLER' }); return; }
    if (r.method === 'GET' && rest === '') { this.send(res, 200, snap); return; }
    if (snap.link.identityCheck.status === 'mismatch') {
      this.send(res, 409, { error: 'answers as a different controller (system id {y}, expected {x})', code: 'IDENTITY_MISMATCH' });
      return;
    }
    if (r.method === 'GET' && rest === '/events') {
      const all: Json[] = this.events.get(id) ?? [];
      const since = url.searchParams.get('since');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const list = since === null ? all.slice(-limit) : all.filter(e => e.seq > Number(since)).slice(0, limit);
      this.send(res, 200, {
        feed: snap.events.feed ?? 'feed-aaaa1111',
        firstSeq: all.length ? all[0].seq : 0,
        lastSeq: all.length ? all[all.length - 1].seq : 0,
        gap: since !== null && all.length > 0 && all[0].seq > Number(since) + 1,
        more: since !== null && all.filter(e => e.seq > Number(since)).length > limit,
        events: list,
      });
      return;
    }
    if (r.method === 'GET' && rest === '/io/signals') {
      const table: Json[] = this.signals.get(id) ?? [];
      if ([...url.searchParams.keys()].length === 0) { this.send(res, 200, { signals: table }); return; }
      const found = this.search ? this.search(id, url.searchParams) : table.filter(s => {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        return (!name || s.name.toLowerCase().startsWith(name.toLowerCase())) && (!type || s.type === type);
      });
      this.send(res, 200, { signals: found });
      return;
    }
    const mod = /^\/rapid\/tasks\/([^/]+)\/modules\/([^/]+)$/.exec(rest);
    if (r.method === 'GET' && mod) {
      const key = `${id}/${decodeURIComponent(mod[1])}/${decodeURIComponent(mod[2])}`;
      const text = this.modules.get(key);
      if (text === undefined) { this.send(res, 404, { error: 'module not found', code: 'MODULE_NOT_FOUND' }); return; }
      this.send(res, 200, { task: decodeURIComponent(mod[1]), module: decodeURIComponent(mod[2]), kind: 'program', text, changeCount: 3 });
      return;
    }
    if (r.method === 'POST' && rest === '/motion/watch') {
      let leaseId: string | undefined;
      try { leaseId = r.body ? JSON.parse(r.body).leaseId : undefined; } catch { leaseId = undefined; }
      const granted = leaseId === 'new' ? `lease-${++this.leaseCounter}` : leaseId;
      this.onLease?.(id);
      this.send(res, 200, { leaseMs: 15000, targetHz: 8, ...(granted ? { leaseId: granted } : {}) });
      return;
    }
    this.send(res, 404, { error: 'no route', code: 'NO_ROUTE' });
  }
}

/** Make the motion group of `id` sample from now on: watching, asOf moving with each read, joints moving by `step` deg per read. */
export function sampleOnRead(fake: FakeDaemon, id: string, step = 0): void {
  const snap = fake.controllers.get(id);
  let n = 0;
  const original = snap.motion;
  Object.defineProperty(snap, 'motion', {
    configurable: true,
    enumerable: true,
    get() {
      n++;
      return {
        ...original,
        watching: true,
        rate: { targetHz: 8, achievedHz: 8, via: 'poll' },
        asOf: iso(Date.now()),
        units: original.units.map((u: Json) => ({
          ...u,
          joints: u.joints.map((j: Json) => ({ ...j, value: j.value + n * step })),
        })),
      };
    },
  });
}

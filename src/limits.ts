/**
 * This server's own limit on the reads that reach a controller (a signal
 * search, a module read), per controller: one in flight, and a token bucket of
 * two that refills one every 2 s. The daemon's read budget is shared with the
 * panel and the bridge; an assistant in a loop must not use all of it. A read
 * over the limit is answered BUSY here and the daemon is not contacted. All in
 * memory, refilled from timestamps: no timer runs.
 */

export const BUCKET_SIZE = 2;
export const REFILL_MS = 2_000;
export const IN_FLIGHT_MAX = 1;

interface Bucket {
  tokens: number;
  at: number;
  inFlight: number;
}

export type Grant = { ok: true; release: () => void } | { ok: false; retryAfterS: number };

export class ReadLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  private bucket(controller: string): Bucket {
    const t = this.now();
    let b = this.buckets.get(controller);
    if (!b) {
      b = { tokens: BUCKET_SIZE, at: t, inFlight: 0 };
      this.buckets.set(controller, b);
      return b;
    }
    const refill = Math.floor((t - b.at) / REFILL_MS);
    if (refill > 0) {
      b.tokens = Math.min(BUCKET_SIZE, b.tokens + refill);
      b.at = b.tokens === BUCKET_SIZE ? t : b.at + refill * REFILL_MS;
    }
    return b;
  }

  /** Take one read, or learn how long to wait. Call `release` when the read has its answer. */
  take(controller: string): Grant {
    const b = this.bucket(controller);
    if (b.inFlight >= IN_FLIGHT_MAX) { return { ok: false, retryAfterS: 1 }; }
    if (b.tokens < 1) {
      const waitMs = Math.max(0, b.at + REFILL_MS - this.now());
      return { ok: false, retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    b.tokens -= 1;
    b.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: (): void => {
        if (released) { return; }
        released = true;
        b.inFlight = Math.max(0, b.inFlight - 1);
      },
    };
  }

  /** Whether a read could be taken now, without taking it. */
  wouldAllow(controller: string): boolean {
    const b = this.bucket(controller);
    return b.inFlight < IN_FLIGHT_MAX && b.tokens >= 1;
  }
}

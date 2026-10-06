// Sliding-window limiter, keyed and stored in SQLite: at most `limit` events
// in any `windowMs` period. One row per accepted event, so usage is an exact
// count ("37 of 1000 in the last 60s"). Because the state lives in the
// database, it survives restarts and is shared by every process using the
// same file. Each take() is one IMMEDIATE transaction, so concurrent writers
// can't both claim the last slot.

import { sqlite } from "../db";

export interface RateLimit {
  limit: number;
  windowMs: number;
}

export interface TakeResult {
  ok: boolean;
  /** Milliseconds until one slot frees up; 0 when ok. */
  retryAfterMs: number;
}

/** What takeAll() needs from a limiter. check() must not write; commit() and
 *  reject() are only called inside the same transaction as check(). */
export interface Limiter {
  readonly name: string;
  check(key: string, now: number): TakeResult;
  commit(key: string, now: number): void;
  reject(key: string, now: number): void;
}

export interface TakeAllResult extends TakeResult {
  /** The limiter that refused, when !ok. */
  blockedBy?: Limiter;
}

/** Pass every limiter or count against none: one IMMEDIATE transaction checks
 *  them all, then records the event on each — or the rejection on the first
 *  one that refused, so usage shows which limit is doing the dropping. */
export function takeAll(limiters: Limiter[], key: string, now = Date.now()): TakeAllResult {
  return sqlite.transaction((): TakeAllResult => {
    for (const l of limiters) {
      const r = l.check(key, now);
      if (!r.ok) {
        l.reject(key, now);
        return { ...r, blockedBy: l };
      }
    }
    for (const l of limiters) l.commit(key, now);
    return { ok: true, retryAfterMs: 0 };
  }).immediate();
}

export interface LimitUsage {
  /** 0 = unlimited. */
  limit: number;
  windowSeconds: number;
  /** Events accepted within the current window. */
  used: number;
  remaining: number | null;
  /** Milliseconds until the oldest counted event leaves the window. */
  resetInMs: number;
  /** Events rejected since `rejectedSince`. */
  rejected: number;
  rejectedSince: number | null;
}

const q = {
  prune: sqlite.query("DELETE FROM rate_limit_events WHERE limiter = ? AND key = ? AND at <= ?"),
  count: sqlite.query<{ n: number; oldest: number | null }, [string, string, number]>(
    "SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_limit_events WHERE limiter = ? AND key = ? AND at > ?"),
  // The event whose expiry frees the next slot: `limit` places from the newest.
  nthNewest: sqlite.query<{ at: number }, [string, string, number]>(
    "SELECT at FROM rate_limit_events WHERE limiter = ? AND key = ? ORDER BY at DESC LIMIT 1 OFFSET ?"),
  insert: sqlite.query("INSERT INTO rate_limit_events (limiter, key, at) VALUES (?, ?, ?)"),
  reject: sqlite.query(`
    INSERT INTO rate_limit_counters (limiter, key, rejected, since) VALUES (?, ?, 1, ?)
    ON CONFLICT (limiter, key) DO UPDATE SET rejected = rejected + 1`),
  counter: sqlite.query<{ rejected: number; since: number }, [string, string]>(
    "SELECT rejected, since FROM rate_limit_counters WHERE limiter = ? AND key = ?"),
  clearEvents: sqlite.query("DELETE FROM rate_limit_events WHERE limiter = ?"),
  clearCounters: sqlite.query("DELETE FROM rate_limit_counters WHERE limiter = ?"),
};

export class KeyedLimiter implements Limiter {
  private readonly rateOf: () => RateLimit;

  /** `name` identifies this limiter's rows in the database — keep it stable.
   *  `rate` may be a function, re-read on every call, so limits can change at
   *  runtime without a restart. */
  constructor(readonly name: string, rate: RateLimit | (() => RateLimit)) {
    this.rateOf = typeof rate === "function" ? rate : () => rate;
  }

  get rate(): RateLimit {
    return this.rateOf();
  }

  /** Count one event for `key` if the window has room. */
  take(key: string, now = Date.now()): TakeResult {
    return takeAll([this], key, now);
  }

  check(key: string, now: number): TakeResult {
    const rate = this.rateOf();
    const { n } = q.count.get(this.name, key, now - rate.windowMs)!;
    if (rate.limit <= 0 || n < rate.limit) return { ok: true, retryAfterMs: 0 }; // 0 = unlimited
    const freesAt = q.nthNewest.get(this.name, key, rate.limit - 1)!.at + rate.windowMs;
    return { ok: false, retryAfterMs: Math.max(1, freesAt - now) };
  }

  /** Recorded even when unlimited, so usage stays visible. */
  commit(key: string, now: number) {
    q.prune.run(this.name, key, now - this.rateOf().windowMs);
    q.insert.run(this.name, key, now);
  }

  reject(key: string, now: number) {
    q.reject.run(this.name, key, now);
  }

  usage(key: string, now = Date.now()): LimitUsage {
    const rate = this.rateOf();
    const { n, oldest } = q.count.get(this.name, key, now - rate.windowMs)!;
    const counter = q.counter.get(this.name, key);
    return {
      limit: rate.limit,
      windowSeconds: rate.windowMs / 1000,
      used: n,
      remaining: rate.limit > 0 ? Math.max(0, rate.limit - n) : null,
      resetInMs: oldest === null ? 0 : oldest + rate.windowMs - now,
      rejected: counter?.rejected ?? 0,
      rejectedSince: counter?.since ?? null,
    };
  }

  /** Forget all usage and rejection counts for this limiter. */
  reset() {
    q.clearEvents.run(this.name);
    q.clearCounters.run(this.name);
  }
}

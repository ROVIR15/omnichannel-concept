// Calendar-day limiter, stored in SQLite: at most `limit` events per day,
// resetting at midnight in the server's timezone (set TZ to change it). One
// counter row per day, so past days remain as a usage history.

import { sqlite } from "../db";
import type { Limiter, TakeResult } from "./limiter";

export interface DailyUsage {
  /** 0 = unlimited. */
  limit: number;
  /** YYYY-MM-DD, server timezone. */
  day: string;
  used: number;
  remaining: number | null;
  /** Milliseconds until midnight, when the count resets. */
  resetInMs: number;
  /** Events refused by this limit today. */
  rejected: number;
}

const q = {
  get: sqlite.query<{ used: number; rejected: number }, [string, string, string]>(
    "SELECT used, rejected FROM rate_limit_daily WHERE limiter = ? AND key = ? AND day = ?"),
  commit: sqlite.query(`
    INSERT INTO rate_limit_daily (limiter, key, day, used) VALUES (?, ?, ?, 1)
    ON CONFLICT (limiter, key, day) DO UPDATE SET used = used + 1`),
  reject: sqlite.query(`
    INSERT INTO rate_limit_daily (limiter, key, day, rejected) VALUES (?, ?, ?, 1)
    ON CONFLICT (limiter, key, day) DO UPDATE SET rejected = rejected + 1`),
  clear: sqlite.query("DELETE FROM rate_limit_daily WHERE limiter = ?"),
};

export function dayOf(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function msUntilMidnight(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now;
}

export class DailyLimiter implements Limiter {
  private readonly limitOf: () => number;

  /** `name` identifies this limiter's rows — keep it stable. `limit` may be a
   *  function, re-read on every call; 0 = unlimited. */
  constructor(readonly name: string, limit: number | (() => number)) {
    this.limitOf = typeof limit === "function" ? limit : () => limit;
  }

  get limit(): number {
    return this.limitOf();
  }

  check(key: string, now: number): TakeResult {
    const limit = this.limitOf();
    const used = q.get.get(this.name, key, dayOf(now))?.used ?? 0;
    if (limit <= 0 || used < limit) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: msUntilMidnight(now) };
  }

  /** Recorded even when unlimited, so usage stays visible. */
  commit(key: string, now: number) {
    q.commit.run(this.name, key, dayOf(now));
  }

  reject(key: string, now: number) {
    q.reject.run(this.name, key, dayOf(now));
  }

  usage(key: string, now = Date.now()): DailyUsage {
    const limit = this.limitOf();
    const row = q.get.get(this.name, key, dayOf(now));
    const used = row?.used ?? 0;
    return {
      limit,
      day: dayOf(now),
      used,
      remaining: limit > 0 ? Math.max(0, limit - used) : null,
      resetInMs: msUntilMidnight(now),
      rejected: row?.rejected ?? 0,
    };
  }

  /** Forget all daily counts for this limiter, history included. */
  reset() {
    q.clear.run(this.name);
  }
}

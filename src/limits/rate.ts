// Rate limit settings are strings "<count>/<seconds>", e.g. 20/60 = 20 per
// minute. A count of 0 disables that limit. Every settings key ending in
// "_limit" uses this format — except "_daily_limit" keys, which are a plain
// count per calendar day.

import type { RateLimit } from "./limiter";

export const DISABLED: RateLimit = { limit: 0, windowMs: 1000 };

export function parseRateLimit(raw: string): RateLimit | null {
  const m = raw.trim().match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!m || Number(m[2]) <= 0) return null;
  return { limit: Number(m[1]), windowMs: Number(m[2]) * 1000 };
}

const warned = new Set<string>();

/** Parse a stored value, falling back (with one warning) when it's malformed. */
export function rateOrDefault(key: string, raw: string, fallback: RateLimit): RateLimit {
  if (!raw) return fallback;
  const parsed = parseRateLimit(raw);
  if (!parsed && !warned.has(`${key}=${raw}`)) {
    warned.add(`${key}=${raw}`);
    console.warn(`[limits] ${key}="${raw}" is not "<count>/<seconds>", using the default`);
  }
  return parsed ?? fallback;
}

/** A daily limit: a whole number, 0 or blank = unlimited. */
export function parseDailyLimit(raw: string): number | null {
  const v = raw.trim();
  if (!v) return 0;
  return /^\d+$/.test(v) ? Number(v) : null;
}

export function dailyOrUnlimited(key: string, raw: string): number {
  const parsed = parseDailyLimit(raw);
  if (parsed === null && !warned.has(`${key}=${raw}`)) {
    warned.add(`${key}=${raw}`);
    console.warn(`[limits] ${key}="${raw}" is not a whole number, treating it as unlimited`);
  }
  return parsed ?? 0;
}

/** For the settings endpoint: a message for the first invalid limit, or null.
 *  Blank is valid — it means "fall back to .env or the default". */
export function invalidLimitSetting(patch: Record<string, string>): string | null {
  for (const [key, v] of Object.entries(patch)) {
    if (key.endsWith("_daily_limit")) {
      if (parseDailyLimit(v) === null) return `${key}: "${v}" must be a whole number of messages per day, e.g. 5000`;
      continue;
    }
    if (key.endsWith("_limit") && v && !parseRateLimit(v)) {
      return `${key}: "${v}" must look like <count>/<seconds>, e.g. 20/60`;
    }
  }
  return null;
}

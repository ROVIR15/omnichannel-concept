// Outbound throttle: a total cap on WhatsApp messages sent, across every
// number. Rejects with a retry hint before calling the Graph API.

import { DailyLimiter, KeyedLimiter, takeAll } from "../limits";
import { whatsappDailyLimit, whatsappLimit } from "./config";
import { TOTAL } from "./inbound";

export const outboundLimiter = new KeyedLimiter("whatsapp-outbound", () => whatsappLimit("whatsapp_outbound_limit"));
export const outboundDailyLimiter = new DailyLimiter("whatsapp-outbound-daily", () => whatsappDailyLimit("whatsapp_outbound_daily_limit"));

/** Meta error codes that mean "slow down". */
export const META_RATE_LIMIT_CODES = new Set([
  4, 80007, // app / WABA call rate
  130429,   // throughput reached for this phone number
  131056,   // pair rate limit: too many messages to the same recipient
]);

export function gateOutbound(now = Date.now()):
  { ok: true } | { ok: false; error: string; retryAfterMs: number } {
  const r = takeAll([outboundDailyLimiter, outboundLimiter], TOTAL, now);
  if (r.ok) return { ok: true };
  const daily = r.blockedBy === outboundDailyLimiter;
  return {
    ok: false,
    retryAfterMs: r.retryAfterMs,
    error: daily
      ? `rate limited: WhatsApp daily outbound limit (${outboundDailyLimiter.limit}) reached, resets at midnight in ${formatWait(r.retryAfterMs)}`
      : `rate limited: WhatsApp outbound limit reached, retry in ${formatWait(r.retryAfterMs)}`,
  };
}

function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

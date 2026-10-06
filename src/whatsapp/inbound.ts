// Inbound throttle: a total cap on WhatsApp messages accepted, across every
// number. Runs after signature verification (so forged deliveries can't use
// up the allowance) and before ingest.
//
// Over-limit messages are dropped and logged, but the webhook still answers
// 200: a 429 at Meta only triggers retries of the same flood, and sustained
// failures get the webhook disabled.

import { DailyLimiter, KeyedLimiter, takeAll } from "../limits";
import type { NormalizedMessage } from "../types";
import { whatsappDailyLimit, whatsappLimit } from "./config";

export const TOTAL = "all";

export const inboundLimiter = new KeyedLimiter("whatsapp-inbound", () => whatsappLimit("whatsapp_inbound_limit"));
export const inboundDailyLimiter = new DailyLimiter("whatsapp-inbound-daily", () => whatsappDailyLimit("whatsapp_inbound_daily_limit"));

export interface ThrottleResult {
  allowed: NormalizedMessage[];
  throttled: NormalizedMessage[];
}

/** Non-WhatsApp messages pass through untouched. */
export function throttleInbound(messages: NormalizedMessage[], now = Date.now()): ThrottleResult {
  const result: ThrottleResult = { allowed: [], throttled: [] };

  for (const m of messages) {
    if (m.channelType !== "whatsapp") { result.allowed.push(m); continue; }

    const r = takeAll([inboundDailyLimiter, inboundLimiter], TOTAL, now);
    if (r.ok) { result.allowed.push(m); continue; }
    console.warn(
      `[whatsapp] ${r.blockedBy === inboundDailyLimiter ? "daily " : ""}inbound limit reached` +
      ` — dropped msg=${m.externalMessageId} from ${m.externalUserId}` +
      ` retryIn=${r.retryAfterMs}ms`,
    );
    result.throttled.push(m);
  }

  return result;
}

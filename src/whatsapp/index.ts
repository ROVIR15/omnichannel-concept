// WhatsApp: connector plus total limits on incoming and outgoing messages.
// Limits are editable on the Settings page; see config.ts.

import { TOTAL, inboundDailyLimiter, inboundLimiter } from "./inbound";
import { outboundDailyLimiter, outboundLimiter } from "./outbound";

export { whatsappConnector } from "./connector";
export { throttleInbound, inboundDailyLimiter, inboundLimiter } from "./inbound";
export { gateOutbound, outboundDailyLimiter, outboundLimiter } from "./outbound";
export { whatsappDailyLimit, whatsappLimit, whatsappLimits } from "./config";
export {
  WHATSAPP_DAILY_LIMIT_KEYS, WHATSAPP_LIMIT_DEFAULTS, type WhatsAppDailyLimitKey, type WhatsAppLimitKey,
} from "./defaults";

/** Current usage, for the Settings page. */
export function whatsappUsage(now = Date.now()) {
  return {
    inbound: { window: inboundLimiter.usage(TOTAL, now), daily: inboundDailyLimiter.usage(TOTAL, now) },
    outbound: { window: outboundLimiter.usage(TOTAL, now), daily: outboundDailyLimiter.usage(TOTAL, now) },
  };
}

// Rate limits for WhatsApp traffic, editable on the Settings page.
// Resolution: saved setting > env var (WHATSAPP_*_LIMIT) > default.
// Format is "<count>/<seconds>", e.g. 20/60, or a plain count for the daily
// limits (see src/limits/rate.ts).
// Read on every check, so a saved change applies without a restart.

import { dailyOrUnlimited, parseRateLimit, rateOrDefault, type RateLimit } from "../limits";
import { appSetting } from "../settings";
import { WHATSAPP_LIMIT_DEFAULTS, type WhatsAppDailyLimitKey, type WhatsAppLimitKey } from "./defaults";

export function whatsappLimit(key: WhatsAppLimitKey): RateLimit {
  return rateOrDefault(key, appSetting(key), parseRateLimit(WHATSAPP_LIMIT_DEFAULTS[key])!);
}

export function whatsappLimits(): Record<WhatsAppLimitKey, RateLimit> {
  return Object.fromEntries(
    (Object.keys(WHATSAPP_LIMIT_DEFAULTS) as WhatsAppLimitKey[]).map((k) => [k, whatsappLimit(k)]),
  ) as Record<WhatsAppLimitKey, RateLimit>;
}

/** Messages per calendar day; 0 = unlimited. */
export function whatsappDailyLimit(key: WhatsAppDailyLimitKey): number {
  return dailyOrUnlimited(key, appSetting(key));
}

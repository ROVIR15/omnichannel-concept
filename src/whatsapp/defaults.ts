// Default WhatsApp rate limits, as "<count>/<seconds>". No imports, so both
// settings.ts (UI fields) and config.ts (runtime) can use it without a cycle.

export const WHATSAPP_LIMIT_DEFAULTS = {
  /** Total WhatsApp messages accepted from customers, across all numbers. */
  whatsapp_inbound_limit: "1000/60",
  /** Total WhatsApp messages sent, across all numbers. */
  whatsapp_outbound_limit: "1000/60",
} as const;

export type WhatsAppLimitKey = keyof typeof WHATSAPP_LIMIT_DEFAULTS;

/** Per-calendar-day totals: a plain count, blank or 0 = unlimited (the default). */
export const WHATSAPP_DAILY_LIMIT_KEYS = ["whatsapp_inbound_daily_limit", "whatsapp_outbound_daily_limit"] as const;

export type WhatsAppDailyLimitKey = (typeof WHATSAPP_DAILY_LIMIT_KEYS)[number];

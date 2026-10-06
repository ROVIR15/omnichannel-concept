// Guard checks: idempotency, the session window, length caps and rate limits.
// Run via `make check`, which uses an in-memory database — run directly, this
// writes test traffic (including rate limit usage) into the real one.
import { ingest, checkSendable } from "../src/core";
import { setLastInboundAt, listOrgs, listConversations } from "../src/store";
import { whatsappConnector } from "../src/whatsapp";
import { seedIfEmpty } from "../src/seed";

seedIfEmpty();
const org = listOrgs()[0]!;

const payload = JSON.stringify({object:"whatsapp_business_account",entry:[{id:"WABA_1",changes:[{field:"messages",value:{
  metadata:{phone_number_id:"WA_1"},contacts:[{profile:{name:"Rina"}}],
  messages:[{from:"628999000111",id:"wamid.guardtest",timestamp:"1735689800",type:"text",text:{body:"hi"}}]}}]}]});

console.log("ingest  :", JSON.stringify(ingest(whatsappConnector.parseInbound(payload))));
console.log("replay  :", JSON.stringify(ingest(whatsappConnector.parseInbound(payload))), "(must be a duplicate)");

const conv = listConversations(org.id).find(c => c.channel_type === "whatsapp")!;
console.log("fresh   :", checkSendable(conv.id, "hello").ok);

setLastInboundAt(conv.id, Date.now() - 25 * 3600_000);
console.log("stale   :", JSON.stringify(checkSendable(conv.id, "hello")));
console.log("toolong :", JSON.stringify(checkSendable(conv.id, "x".repeat(5000))));

// Limits — fixed clock, so the result doesn't depend on timing.
import { gateOutbound, throttleInbound, whatsappLimits, whatsappUsage } from "../src/whatsapp";
import { DailyLimiter, KeyedLimiter, invalidLimitSetting, takeAll } from "../src/limits";
const WA_LIMITS = whatsappLimits();
const t0 = 1_000_000;

const lim = new KeyedLimiter("check-window", { limit: 2, windowMs: 1000 });
console.log("window  :", [lim.take("k", t0).ok, lim.take("k", t0 + 100).ok, lim.take("k", t0 + 500).ok, lim.take("k", t0 + 1001).ok].join(","), "(must be true,true,false,true)");
const lu = lim.usage("k", t0 + 1001);
console.log("usage   :", `used=${lu.used} rejected=${lu.rejected}`, "(must be used=2 rejected=1)");

const flood = Array.from({ length: WA_LIMITS.whatsapp_inbound_limit.limit + 3 }, (_, i) =>
  ({ ...whatsappConnector.parseInbound(payload)[0]!, externalMessageId: `wamid.flood${i}` }));
console.warn = () => {}; // the flood logs one line per dropped message
const th = throttleInbound(flood, t0);
console.log("inflood :", `allowed=${th.allowed.length} throttled=${th.throttled.length}`, "(throttled must be 3)");

let outBlocked = 0;
for (let i = 0; i < WA_LIMITS.whatsapp_outbound_limit.limit + 2; i++) if (!gateOutbound(t0).ok) outBlocked++;
console.log("outflood:", `blocked=${outBlocked}`, "(must be 2)");
const u = whatsappUsage(t0);
const w = (x: typeof u.inbound) => `${x.window.used}/${x.window.limit} rejected=${x.window.rejected} today=${x.daily.used}`;
console.log("waUsage :", `in ${w(u.inbound)}, out ${w(u.outbound)}`);

// Limits follow the setting at runtime, no restart.
let limitNow = { limit: 1, windowMs: 1000 };
const live = new KeyedLimiter("check-live", () => limitNow);
const before = live.take("k", t0).ok && !live.take("k", t0).ok;
limitNow = { limit: 5, windowMs: 1000 };
console.log("live    :", before && live.take("k", t0 + 200).ok, "(must be true)");
console.log("format  :", invalidLimitSetting({ whatsapp_inbound_limit: "1000/60" }) === null && invalidLimitSetting({ whatsapp_outbound_limit: "fast" }) !== null, "(must be true)");

// Daily limits: count per calendar day, reset at midnight.
const noon = new Date(2026, 9, 6, 12).getTime();
const day = new DailyLimiter("check-daily", 2);
console.log("daily   :", [day.check("k", noon).ok, (day.commit("k", noon), day.commit("k", noon), day.check("k", noon).ok),
  day.check("k", new Date(2026, 9, 7, 0, 0, 1).getTime()).ok].join(","), "(must be true,false,true)");
console.log("dayReset:", Math.round(day.check("k", noon).retryAfterMs / 3600_000) + "h", "(must be 12h)");

// A message the daily limit blocks must not use a per-minute slot.
const dayFull = new DailyLimiter("check-daily-full", 1);
const minute = new KeyedLimiter("check-minute", { limit: 10, windowMs: 60_000 });
const both = [takeAll([dayFull, minute], "k", noon), takeAll([dayFull, minute], "k", noon)];
console.log("combined:", both.map(r => r.ok).join(","), `blockedBy=${both[1]!.blockedBy?.name} minuteUsed=${minute.usage("k", noon).used} dailyRejected=${dayFull.usage("k", noon).rejected}`,
  "(must be true,false blockedBy=check-daily-full minuteUsed=1 dailyRejected=1)");
console.log("dayFmt  :", invalidLimitSetting({ whatsapp_inbound_daily_limit: "5000" }) === null && invalidLimitSetting({ whatsapp_inbound_daily_limit: "" }) === null
  && invalidLimitSetting({ whatsapp_outbound_daily_limit: "5000/86400" }) !== null, "(must be true)");

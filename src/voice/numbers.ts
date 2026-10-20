// Phone numbers per organisation. A client enters a number they own in
// another Twilio account; it waits as "pending" until its owner has Twilio
// transfer it into ours. A watcher looks for pending numbers every few
// minutes, points each one that has arrived at our voice webhook, and marks
// it "active". From then on its calls ring only that organisation's agents.

import { db, type VoiceUser } from "./context";
import { twilioGet, twilioPost, voiceConfig } from "./twilio";

export type NumberStatus = "pending" | "active";

interface NumberRow {
  phone_number: string;
  org_id: string;
  status: NumberStatus;
  twilio_sid: string | null;
  error: string | null;
  requested_at: number;
  connected_at: number | null;
  last_checked_at: number | null;
}

const toNumber = (r: NumberRow) => ({
  phoneNumber: r.phone_number,
  orgId: r.org_id,
  status: r.status,
  error: r.error,
  requestedAt: r.requested_at,
  connectedAt: r.connected_at,
  lastCheckedAt: r.last_checked_at,
});

export type VoiceNumber = ReturnType<typeof toNumber>;

const WATCH_EVERY_MS = 5 * 60_000;
const E164 = /^\+[1-9]\d{6,14}$/;

const getRow = (phone: string) =>
  db().query<NumberRow, [string]>("SELECT * FROM voice_numbers WHERE phone_number = ?").get(phone);

/** "+1 (800) 555-0123" → "+18005550123", or null when it isn't +E.164. */
export function normalizeNumber(input: string): string | null {
  const n = input.replace(/[\s().-]/g, "");
  return E164.test(n) ? n : null;
}

export function listNumbers(orgId: string): VoiceNumber[] {
  return db().query<NumberRow, [string]>("SELECT * FROM voice_numbers WHERE org_id = ? ORDER BY requested_at")
    .all(orgId).map(toNumber);
}

/** The organisation an active number belongs to; null for the platform number. */
export function orgForNumber(phone: string): string | null {
  return db().query<{ org_id: string }, [string]>(
    "SELECT org_id FROM voice_numbers WHERE phone_number = ? AND status = 'active'",
  ).get(phone)?.org_id ?? null;
}

/** Caller ID for a user's outbound calls: their organisation's first active
 *  number, else the platform number from Settings. */
export function callerIdFor(user: VoiceUser | null): string {
  const own = user?.orgId
    ? db().query<{ phone_number: string }, [string]>(
      "SELECT phone_number FROM voice_numbers WHERE org_id = ? AND status = 'active' ORDER BY connected_at LIMIT 1",
    ).get(user.orgId)?.phone_number
    : undefined;
  return own ?? voiceConfig().phoneNumber;
}

export async function addNumber(orgId: string, input: string): Promise<{ ok: true; number: VoiceNumber } | { ok: false; error: string }> {
  const phone = normalizeNumber(input);
  if (!phone) return { ok: false, error: "Enter the number in international format, starting with +, e.g. +18005550123." };

  const existing = getRow(phone);
  if (existing && existing.org_id !== orgId) return { ok: false, error: "This number is already connected to another organisation." };
  if (!existing) {
    db().query("INSERT INTO voice_numbers (phone_number, org_id, status, requested_at) VALUES (?, ?, 'pending', ?)")
      .run(phone, orgId, Date.now());
  }
  // It may already be in our account (bought by us, or transferred early).
  return { ok: true, number: await connectIfArrived(getRow(phone)!) };
}

export function removeNumber(orgId: string, phone: string): boolean {
  return db().query("DELETE FROM voice_numbers WHERE phone_number = ? AND org_id = ?").run(phone, orgId).changes > 0;
}

/** Check every pending number now (all organisations, or one). */
export async function checkPendingNumbers(orgId?: string): Promise<void> {
  const rows = orgId
    ? db().query<NumberRow, [string]>("SELECT * FROM voice_numbers WHERE status = 'pending' AND org_id = ?").all(orgId)
    : db().query<NumberRow, []>("SELECT * FROM voice_numbers WHERE status = 'pending'").all();
  for (const row of rows) await connectIfArrived(row);
}

/** Returns a function that stops the watcher. */
export function startNumberWatcher(): () => void {
  const timer = setInterval(() => {
    checkPendingNumbers().catch((e) => console.warn(`[voice] number watcher: ${e}`));
  }, WATCH_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Our voice webhook, read from the TwiML App so there is one place to set
 *  it. Null when the app has no Voice URL yet. */
async function voiceWebhookUrl(): Promise<string | null> {
  const app = await twilioGet<{ voice_url: string | null }>(`/Applications/${voiceConfig().twimlAppSid}.json`);
  return app?.voice_url || null;
}

/** If the number is in our Twilio account now, point it at our webhooks and
 *  mark it active. Otherwise note when we looked and why it isn't ready. */
async function connectIfArrived(row: NumberRow): Promise<VoiceNumber> {
  if (row.status === "active") return toNumber(row);
  const note = (error: string | null) => {
    db().query("UPDATE voice_numbers SET error = ?, last_checked_at = ? WHERE phone_number = ?")
      .run(error, Date.now(), row.phone_number);
    return toNumber(getRow(row.phone_number)!);
  };

  type Found = { incoming_phone_numbers: { sid: string }[] };
  const found = await twilioGet<Found>(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(row.phone_number)}`);
  if (!found) return note("Couldn't reach Twilio. Check the Twilio settings.");
  const sid = found.incoming_phone_numbers[0]?.sid;
  if (!sid) return note(null); // not transferred yet

  const voiceUrl = await voiceWebhookUrl();
  if (!voiceUrl) return note("The number has arrived, but the TwiML App has no Voice URL to point it at.");

  // Clear anything the previous owner set, so every call comes to us.
  const updated = await twilioPost(`/IncomingPhoneNumbers/${sid}.json`, {
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
    VoiceFallbackUrl: "",
    VoiceApplicationSid: "",
    StatusCallback: new URL("/webhooks/twilio/status", voiceUrl).href,
    StatusCallbackMethod: "POST",
  });
  if (!updated) return note("The number has arrived, but Twilio refused the webhook update. Retrying.");

  db().query(`
    UPDATE voice_numbers SET status = 'active', twilio_sid = ?, error = NULL, connected_at = ?, last_checked_at = ?
    WHERE phone_number = ?`,
  ).run(sid, Date.now(), Date.now(), row.phone_number);
  console.log(`[voice] number ${row.phone_number} is active for org ${row.org_id}`);
  return toNumber(getRow(row.phone_number)!);
}

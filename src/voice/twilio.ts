// Minimal Twilio Voice: browser access tokens, webhook signature checks and
// the TwiML that connects calls. No Twilio SDK dependency — the token is a
// plain HS256 JWT and TwiML is a few lines of XML.

import { voiceDeps } from "./context";

export const voiceConfig = () => voiceDeps().settings();

/** Which settings are still blank, by label — for a readable error. */
export function missingForCalls(): string[] {
  const c = voiceConfig();
  return [
    !c.accountSid && "Account SID",
    !c.apiKeySid && "API Key SID",
    !c.apiKeySecret && "API Key Secret",
    !c.twimlAppSid && "TwiML App SID",
    !c.phoneNumber && "Phone Number",
  ].filter(Boolean) as string[];
}

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");

/** Access token for the Voice JS SDK: lets `identity` make calls through the
 *  TwiML App and receive calls dialled to <Client>identity</Client>. */
export function voiceToken(identity: string, ttlSeconds = 3600): string {
  const c = voiceConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${c.apiKeySid}-${now}`,
    iss: c.apiKeySid,
    sub: c.accountSid,
    iat: now,
    exp: now + ttlSeconds,
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: c.twimlAppSid },
      },
    },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Bun.CryptoHasher("sha256", c.apiKeySecret).update(unsigned).digest();
  return `${unsigned}.${b64url(sig)}`;
}

/** Twilio signs webhooks: base64(HMAC-SHA1(authToken, url + sorted key+value
 *  pairs)). The url must be the public one Twilio called. Blank auth token =
 *  check skipped (dev), matching the Meta webhook behaviour. */
export function validTwilioSignature(publicUrl: string, params: Record<string, string>, header: string | null): boolean {
  const { authToken } = voiceConfig();
  if (!authToken) return true;
  if (!header) return false;
  const data = publicUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = new Bun.CryptoHasher("sha1", authToken).update(data).digest("base64");
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

export const twiml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml" },
  });

/** Browser → phone. `before` is TwiML to run first, e.g. startTranscription(). */
export function dialNumber(to: string, callerId: string, before = "") {
  return twiml(`${before}<Dial callerId="${xml(callerId)}" answerOnBridge="true"><Number>${xml(to)}</Number></Dial>`);
}

/** Phone → browsers. Rings every identity at once; first to answer wins. */
export function dialClients(identities: string[], timeoutSeconds = 25, before = "") {
  if (identities.length === 0) {
    return twiml(`<Say>Sorry, no one is available to take your call. Please try again later.</Say><Hangup/>`);
  }
  const clients = identities.slice(0, 10).map((id) => `<Client>${xml(id)}</Client>`).join("");
  return twiml(`${before}<Dial timeout="${timeoutSeconds}" answerOnBridge="true">${clients}</Dial>`);
}

/** Fixed for now; a language setting is a later step. */
export const TRANSCRIPT_LANGUAGE = "en-US";

export const transcriptionEnabled = () => voiceConfig().transcription;

/** Real-Time Transcription of both sides of the call. <Start> doesn't block,
 *  so this goes before the <Dial>. Twilio posts each sentence to callbackUrl. */
export function startTranscription(callbackUrl: string, labels: { inbound: string; outbound: string }) {
  return `<Start><Transcription name="live" statusCallbackUrl="${xml(callbackUrl)}" track="both_tracks"`
    + ` inboundTrackLabel="${xml(labels.inbound)}" outboundTrackLabel="${xml(labels.outbound)}"`
    + ` languageCode="${TRANSCRIPT_LANGUAGE}"/></Start>`;
}

/** GET on the Twilio REST API (2010-04-01), under our account. Null when the
 *  credentials are missing or Twilio says no — callers treat it as "not known yet". */
export async function twilioGet<T>(path: string): Promise<T | null> {
  const { accountSid, authToken } = voiceConfig();
  if (!accountSid || !authToken) return null;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
    headers: { authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` },
  }).catch(() => null);
  if (!res?.ok) {
    console.warn(`[voice] Twilio GET ${path} failed: ${res?.status ?? "network error"}`);
    return null;
  }
  return res.json() as Promise<T>;
}

/** POST (create or update) on the Twilio REST API, under our account. Null
 *  on failure, with the reason logged. */
export async function twilioPost<T>(path: string, form: Record<string, string>): Promise<T | null> {
  const { accountSid, authToken } = voiceConfig();
  if (!accountSid || !authToken) return null;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` },
    body: new URLSearchParams(form),
  }).catch(() => null);
  if (!res?.ok) {
    console.warn(`[voice] Twilio POST ${path} failed: ${res?.status ?? "network error"} ${await res?.text().catch(() => "") ?? ""}`);
    return null;
  }
  return res.json() as Promise<T>;
}

export const sayError =(message: string) => twiml(`<Say>${xml(message)}</Say><Hangup/>`);

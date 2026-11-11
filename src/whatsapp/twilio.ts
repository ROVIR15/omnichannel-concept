// WhatsApp through Twilio: the second provider for the "whatsapp" channel.
// An account uses it when credentials.provider === "twilio"; its externalId
// is the Twilio sender number in E.164 (+14155238886), no "whatsapp:" prefix.
//
// Inbound: Twilio POSTs a form to /webhooks/twilio/whatsapp.
// Outbound: POST /Messages.json with From/To prefixed "whatsapp:".
// Same limits as Meta (gateOutbound / throttleInbound).

import { appSetting } from "../settings";
import type { ChannelAccount, MessageType, NormalizedMessage, OutboundMessage, SendResult } from "../types";
import { twilioSignatureMatches } from "../voice/twilio";
import { gateOutbound } from "./outbound";

export const isTwilioAccount = (a: ChannelAccount) => a.credentials.provider?.trim().toLowerCase() === "twilio";

/** Always the app-level Twilio account from Settings (same one voice uses). */
function twilioCreds() {
  return {
    accountSid: appSetting("twilio_account_sid"),
    authToken: appSetting("twilio_auth_token"),
  };
}

const stripPrefix = (addr: string | undefined) => (addr ?? "").replace(/^whatsapp:/i, "").trim();

function mediaType(mime: string | undefined): MessageType {
  const top = (mime ?? "").split("/")[0];
  if (top === "image" || top === "audio" || top === "video") return top;
  return mime ? "file" : "unknown";
}

/** The form Twilio posts, as one normalized message. Empty when it isn't a
 *  message (e.g. a status callback pointed here by mistake). */
export function parseTwilioWhatsapp(params: Record<string, string>): NormalizedMessage[] {
  if (!params.MessageSid || !params.From || !params.To) return [];

  const attachments = Array.from({ length: Number(params.NumMedia) || 0 }, (_, i) => {
    const mimeType = params[`MediaContentType${i}`];
    return { type: mediaType(mimeType), url: params[`MediaUrl${i}`], mimeType };
  });
  const type: MessageType =
    params.Latitude && params.Longitude ? "location"
    : attachments.length ? attachments[0]!.type
    : "text";

  return [{
    channelType: "whatsapp",
    accountExternalId: stripPrefix(params.To),
    externalUserId: stripPrefix(params.From),
    externalMessageId: params.MessageSid,
    direction: "inbound",
    type,
    body: params.Body ?? "",
    attachments,
    timestamp: Date.now(), // Twilio sends no timestamp on inbound messages
    senderName: params.ProfileName || undefined,
    rawPayload: params,
  }];
}

/** X-Twilio-Signature against the Twilio Auth Token in Settings.
 *  Blank token = check skipped, like the Meta webhook in dev. */
export function verifyTwilioWhatsapp(
  publicUrl: string, params: Record<string, string>, header: string | null,
): boolean {
  return twilioSignatureMatches(twilioCreds().authToken, publicUrl, params, header);
}

/** Twilio error codes that mean "slow down". */
const TWILIO_RATE_LIMIT_CODES = new Set([
  20429, // too many requests
  63018, // rate limit exceeded for the WhatsApp sender
]);

export async function sendTwilioWhatsapp(account: ChannelAccount, out: OutboundMessage): Promise<SendResult> {
  const { accountSid, authToken } = twilioCreds();
  if (!accountSid || !authToken) return { ok: false, error: "Twilio Account SID and Auth Token are not set in Settings" };

  const gate = gateOutbound();
  if (!gate.ok) return { ok: false, error: gate.error };

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` },
    body: new URLSearchParams({
      From: `whatsapp:${stripPrefix(account.externalId)}`,
      To: `whatsapp:${stripPrefix(out.to)}`,
      Body: out.body,
    }),
  }).catch((err) => err as Error);
  if (res instanceof Error) return { ok: false, error: `Twilio unreachable: ${res.message}` };

  const json: any = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, externalMessageId: json.sid };

  const message = json.message ?? `HTTP ${res.status}`;
  const limited = res.status === 429 || TWILIO_RATE_LIMIT_CODES.has(json.code);
  return { ok: false, error: limited ? `rate limited by Twilio: ${message}` : message };
}

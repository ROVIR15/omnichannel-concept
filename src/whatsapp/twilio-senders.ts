// Twilio Senders API: register WhatsApp senders by API instead of the Console.
// https://www.twilio.com/docs/whatsapp/register-senders-using-api
//
// Flow:
//   1. createSender  → status CREATING. Twilio SMS number: verified for us.
//      Voice or non-Twilio number: Meta sends an OTP to the number.
//   2. verifySender  → send that OTP back (manual cases only).
//   3. getSender     → poll until status is ONLINE (takes a few minutes).
//
// Note: the first WhatsApp sender on an account must be made with Self
// Sign-up in the Console. Twilio asks for minutes between create calls.

import { appSetting } from "../settings";

const BASE = "https://messaging.twilio.com/v2/Channels/Senders";

export type VerificationMethod = "sms" | "voice";

export interface SenderProfile {
  name: string; // display name, must pass Meta's display name rules
  about?: string;
  address?: string;
  description?: string;
  logo_url?: string;
  vertical?: string;
  websites?: string[];
  emails?: string[];
}

export interface SenderWebhook {
  callback_url?: string;
  callback_method?: "POST" | "GET";
  fallback_url?: string;
  fallback_method?: "POST" | "GET";
  status_callback_url?: string;
  status_callback_method?: "POST" | "GET";
}

export interface CreateSenderInput {
  /** E.164, e.g. +15017122661. "whatsapp:" prefix optional. */
  number: string;
  profile: SenderProfile;
  /** Default sms. Use voice for voice-only numbers. */
  verificationMethod?: VerificationMethod;
  webhook?: SenderWebhook;
}

export interface UpdateSenderInput {
  profile?: Partial<SenderProfile>;
  webhook?: SenderWebhook;
  verificationCode?: string;
}

export type SenderResult =
  | { ok: true; status: number; sender: any }
  | { ok: false; status: number; error: string; code?: number };

/** Twilio codes worth saying in plain words. */
const FRIENDLY: Record<number, string> = {
  20429: "Twilio says too many requests. Wait a few minutes and try again.",
  63110: "This number is already on WhatsApp. Delete that WhatsApp account, or turn off 2FA in WhatsApp Manager, then try again.",
};

const E164 = /^\+[1-9]\d{6,14}$/;

/** "+1 555-0100", "whatsapp:+15550100" → "+15550100". */
export function toE164(raw: string): string {
  return raw.replace(/^whatsapp:/i, "").replace(/[\s().-]/g, "").trim();
}

function auth(): string | null {
  const sid = appSetting("twilio_account_sid");
  const token = appSetting("twilio_auth_token");
  return sid && token ? `Basic ${btoa(`${sid}:${token}`)}` : null;
}

async function call(method: string, path: string, body?: unknown): Promise<SenderResult> {
  const authorization = auth();
  if (!authorization) {
    return { ok: false, status: 400, error: "Twilio Account SID and Auth Token are not set in Settings" };
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((err) => err as Error);
  if (res instanceof Error) return { ok: false, status: 502, error: `Twilio unreachable: ${res.message}` };

  if (res.status === 204) return { ok: true, status: 204, sender: null };
  const json: any = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, sender: json };
  const message = FRIENDLY[json.code] ?? json.message ?? `HTTP ${res.status}`;
  return { ok: false, status: res.status, error: message, code: json.code };
}

const sidPath = (sid: string) => `/${encodeURIComponent(sid)}`;

/** POST /v2/Channels/Senders */
export async function createSender(input: CreateSenderInput): Promise<SenderResult> {
  const number = toE164(input.number ?? "");
  if (!E164.test(number)) return { ok: false, status: 400, error: "number must be E.164, e.g. +15017122661" };
  if (!input.profile?.name?.trim()) return { ok: false, status: 400, error: "profile.name (display name) is required" };
  const method = input.verificationMethod ?? "sms";
  if (method !== "sms" && method !== "voice") {
    return { ok: false, status: 400, error: "verificationMethod must be sms or voice" };
  }

  return call("POST", "", {
    sender_id: `whatsapp:${number}`,
    // sms is Twilio's default; send it only when it differs.
    ...(method === "voice" ? { configuration: { verification_method: "voice" } } : {}),
    ...(input.webhook ? { webhook: input.webhook } : {}),
    profile: { ...input.profile, name: input.profile.name.trim() },
  });
}

/** GET /v2/Channels/Senders/{sid}. Check status === "ONLINE". */
export const getSender = (sid: string) => call("GET", sidPath(sid));

/** GET /v2/Channels/Senders?Channel=whatsapp (one page). */
export function listSenders(pageSize = 50, pageToken?: string) {
  const q = new URLSearchParams({ Channel: "whatsapp", PageSize: String(pageSize) });
  if (pageToken) q.set("PageToken", pageToken);
  return call("GET", `?${q}`);
}

/** POST /v2/Channels/Senders/{sid}: profile, webhook or OTP. */
export async function updateSender(sid: string, input: UpdateSenderInput): Promise<SenderResult> {
  const body: Record<string, unknown> = {};
  if (input.profile) body.profile = input.profile;
  if (input.webhook) body.webhook = input.webhook;
  if (input.verificationCode) body.configuration = { verification_code: input.verificationCode };
  if (!Object.keys(body).length) {
    return { ok: false, status: 400, error: "nothing to update" };
  }
  return call("POST", sidPath(sid), body);
}

/** Send the OTP Meta delivered by SMS or voice. */
export async function verifySender(sid: string, code: string): Promise<SenderResult> {
  const clean = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{4,8}$/.test(clean)) return { ok: false, status: 400, error: "code must be the digits from the OTP" };
  return updateSender(sid, { verificationCode: clean });
}

/** DELETE /v2/Channels/Senders/{sid}. */
export const deleteSender = (sid: string) => call("DELETE", sidPath(sid));

/** Number part of a sender, "whatsapp:+1555…" → "+1555…". */
export const senderNumber = (sender: any) => toE164(String(sender?.sender_id ?? ""));

// One Meta app, three channels. Messenger and Instagram arrive as
// entry[].messaging[]; WhatsApp arrives as entry[].changes[].value.messages[].
// Same webhook, same signature scheme, different payload shapes.

import { appSetting } from "../settings";
import type {
  Capabilities, ChannelAccount, ChannelConnector, ChannelType, CredentialField,
  MessageType, NormalizedMessage, OutboundMessage, SendResult, WebhookRequest,
} from "../types";

const GRAPH = () => `https://graph.facebook.com/${appSetting("meta_graph_version") || "v21.0"}`;

/** Meta signs the raw body with an app secret. Compare against the raw bytes —
 *  re-serializing the JSON changes the hash and breaks this.
 *
 *  Instagram products can be registered with their own app secret, in which
 *  case IG deliveries are signed with that one while Messenger deliveries use
 *  the Facebook app secret. Accept either. */
function hmacHex(secret: string, body: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(body);
  return hasher.digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function signingSecrets(): Array<{ name: string; secret: string }> {
  return [
    { name: "meta_app_secret", secret: appSetting("meta_app_secret") },
    { name: "instagram_app_secret", secret: appSetting("instagram_app_secret") },
  ].filter((s) => s.secret);
}

/** Returns the name of the secret that matched, or null. */
export function matchingSecret(rawBody: string, header: string | null): string | null {
  if (!header?.startsWith("sha256=")) return null;
  const got = header.slice("sha256=".length);
  for (const { name, secret } of signingSecrets()) {
    if (timingSafeEqual(hmacHex(secret, rawBody), got)) return name;
  }
  return null;
}

function verifySignature(rawBody: string, header: string | null): boolean {
  if (signingSecrets().length === 0) return true; // dev mode, no secret configured
  return matchingSecret(rawBody, header) !== null;
}

function baseCaps(over: Partial<Capabilities>): Capabilities {
  return {
    supportsRichText: false,
    supportsTemplates: false,
    hasSessionWindow: true,
    sessionWindowHours: 24,
    mediaTypes: ["image", "file", "audio", "video"],
    maxTextLength: 2000,
    supportsTypingIndicator: true,
    ...over,
  };
}

function metaAttachmentType(t: string): MessageType {
  if (t === "image" || t === "audio" || t === "video") return t;
  if (t === "file" || t === "document") return "file";
  if (t === "location") return "location";
  return "unknown";
}

/** Messenger + Instagram share the payload shape entirely. */
function parseMessagingEntries(body: any, channelType: ChannelType): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      if (!ev.message || ev.message.is_echo) continue;
      const atts = (ev.message.attachments ?? []).map((a: any) => ({
        type: metaAttachmentType(a.type),
        url: a.payload?.url,
      }));
      out.push({
        channelType,
        accountExternalId: String(entry.id),
        externalUserId: String(ev.sender?.id),
        externalMessageId: String(ev.message.mid),
        direction: "inbound",
        type: ev.message.text ? "text" : atts[0]?.type ?? "unknown",
        body: ev.message.text ?? "",
        attachments: atts,
        timestamp: ev.timestamp ?? Date.now(),
        rawPayload: ev,
      });
    }
  }
  return out;
}

const PAGE_FIELDS: CredentialField[] = [
  { key: "pageToken", label: "Page Access Token", secret: true, help: "From the client's OAuth grant, or Graph API Explorer while testing." },
];

export const messengerConnector: ChannelConnector = {
  channelType: () => "messenger",
  capabilities: () => baseCaps({ supportsTemplates: true }),
  credentialFields: () => PAGE_FIELDS,

  handleVerification(req: WebhookRequest) {
    if (req.method !== "GET") return null;
    const p = req.url.searchParams;
    if (
      p.get("hub.mode") === "subscribe" &&
      p.get("hub.verify_token") === appSetting("meta_verify_token")
    ) {
      return new Response(p.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  },

  verifyWebhook(req) {
    return verifySignature(req.rawBody, req.headers.get("x-hub-signature-256"));
  },

  parseInbound(rawBody) {
    const body = JSON.parse(rawBody);
    if (body.object === "instagram") return parseInstagram(body);
    if (body.object === "whatsapp_business_account") return whatsappConnector.parseInbound(rawBody);
    return parseMessagingEntries(body, "messenger");
  },

  async send(account: ChannelAccount, out: OutboundMessage): Promise<SendResult> {
    const res = await fetch(`${GRAPH()}/${account.externalId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.credentials.pageToken}`,
      },
      body: JSON.stringify({
        recipient: { id: out.to },
        messaging_type: "RESPONSE",
        message: { text: out.body },
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, externalMessageId: json.message_id }
      : { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
  },
};

/** Instagram delivers messages in TWO different envelopes depending on the
 *  integration path:
 *
 *    entry[].messaging[]            — Facebook Login path (same as Messenger)
 *    entry[].changes[].value        — Instagram Login path (same shape as
 *                                     WhatsApp uses, with field: "messages")
 *
 *  Accept both, so one connector serves either path. */
function parseInstagram(body: any): NormalizedMessage[] {
  const out: NormalizedMessage[] = parseMessagingEntries(body, "instagram");

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const v = change.value ?? {};
      if (!v.message || v.message.is_echo) continue;

      const atts = (v.message.attachments ?? []).map((a: any) => ({
        type: metaAttachmentType(a.type),
        url: a.payload?.url,
      }));

      // Meta's own test payload sends entry.id = "0"; fall back to the
      // recipient, which is the business account either way.
      const accountId =
        entry.id && entry.id !== "0" ? String(entry.id) : String(v.recipient?.id ?? "");

      out.push({
        channelType: "instagram",
        accountExternalId: accountId,
        externalUserId: String(v.sender?.id ?? ""),
        externalMessageId: String(v.message.mid),
        direction: "inbound",
        type: v.message.text ? "text" : atts[0]?.type ?? "unknown",
        body: v.message.text ?? "",
        attachments: atts,
        timestamp: Number(v.timestamp) * (String(v.timestamp).length <= 10 ? 1000 : 1) || Date.now(),
        rawPayload: v,
      });
    }
  }

  return out;
}

/** Instagram has two integration paths, and they need different send calls:
 *
 *  - Facebook Login  — IG account linked to a Page; send with the Page token
 *    via graph.facebook.com, exactly like Messenger.
 *  - Instagram Login — IG account connected directly; send with an IGAA… user
 *    token via graph.instagram.com and an Authorization header.
 *
 *  Inbound payloads are identical, so only send() branches. Which path is in
 *  use is inferred from which credential the client stored. */
export const instagramConnector: ChannelConnector = {
  ...messengerConnector,
  channelType: () => "instagram",

  credentialFields: () => [
    { key: "igUserToken", label: "Instagram User Token", secret: true, help: "Instagram Login path — starts with IGAA. Leave blank if using a Page token." },
    { key: "pageToken", label: "Page Access Token", secret: true, help: "Facebook Login path — IG account linked to a Facebook Page." },
    { key: "pageId", label: "Page ID (for sending)", secret: false, help: "Facebook Login path only. Inbound arrives on the IG account id, but outbound must POST to the PAGE id — Meta returns error #3 otherwise." },
  ],

  // IG allows no template messages, and caps text shorter than Messenger.
  capabilities: () => baseCaps({ sessionWindowHours: 24, maxTextLength: 1000 }),

  parseInbound: (rawBody) => parseInstagram(JSON.parse(rawBody)),

  async send(account, out): Promise<SendResult> {
    const igToken = account.credentials.igUserToken;

    // Instagram Login path.
    if (igToken) {
      const res = await fetch(`https://graph.instagram.com/${appSetting("meta_graph_version") || "v23.0"}/me/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${igToken}`,
        },
        body: JSON.stringify({ recipient: { id: out.to }, message: { text: out.body } }),
      });
      const json: any = await res.json().catch(() => ({}));
      return res.ok
        ? { ok: true, externalMessageId: json.message_id }
        : { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
    }

    // Facebook Login path. Note the asymmetry: webhooks arrive addressed to the
    // Instagram account id, but the Send API only accepts the PAGE id here —
    // posting to the IG id returns "(#3) Application does not have the
    // capability to make this API call", which reads like a permissions
    // problem and is not one.
    const sendId = account.credentials.pageId || account.externalId;
    return messengerConnector.send(
      { ...account, externalId: sendId },
      out,
    );
  },
};

export const whatsappConnector: ChannelConnector = {
  channelType: () => "whatsapp",
  credentialFields: () => [
    { key: "token", label: "WhatsApp Access Token", secret: true, help: "System user token, or the temporary token from API Setup." },
  ],
  capabilities: () =>
    baseCaps({
      supportsTemplates: true, // the only way to reopen a closed 24h window
      maxTextLength: 4096,
      supportsTypingIndicator: false,
    }),

  handleVerification: messengerConnector.handleVerification,
  verifyWebhook: messengerConnector.verifyWebhook,

  parseInbound(rawBody) {
    const body = JSON.parse(rawBody);
    const out: NormalizedMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id;
        const profileName = value.contacts?.[0]?.profile?.name;
        for (const m of value.messages ?? []) {
          const type: MessageType =
            m.type === "text" ? "text" : metaAttachmentType(m.type);
          out.push({
            channelType: "whatsapp",
            accountExternalId: String(phoneNumberId),
            externalUserId: String(m.from),
            externalMessageId: String(m.id),
            direction: "inbound",
            type,
            body: m.text?.body ?? m[m.type]?.caption ?? "",
            attachments: type === "text" ? [] : [{ type, name: m[m.type]?.id }],
            timestamp: Number(m.timestamp) * 1000 || Date.now(),
            senderName: profileName,
            rawPayload: m,
          });
        }
      }
    }
    return out;
  },

  async send(account, out): Promise<SendResult> {
    const res = await fetch(`${GRAPH()}/${account.externalId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.credentials.token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: out.to,
        type: "text",
        text: { body: out.body },
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, externalMessageId: json.messages?.[0]?.id }
      : { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
  },
};

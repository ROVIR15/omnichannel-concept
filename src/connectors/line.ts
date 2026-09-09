// LINE: the friendliest of the group. Client pastes a channel secret and an
// access token from the LINE Developers console — no partner status needed.

import type {
  ChannelConnector, NormalizedMessage, MessageType, SendResult,
} from "../types";

export const lineConnector: ChannelConnector = {
  channelType: () => "line",

  credentialFields: () => [
    { key: "channelSecret", label: "Channel Secret", secret: true, help: "LINE Developers → Basic settings" },
    { key: "accessToken", label: "Channel Access Token", secret: true, help: "LINE Developers → Messaging API → issue long-lived token" },
  ],

  capabilities: () => ({
    supportsRichText: false,
    supportsTemplates: true, // flex messages
    hasSessionWindow: false, // push messages any time (they're just metered)
    sessionWindowHours: 0,
    mediaTypes: ["image", "video", "audio", "file", "sticker", "location"],
    maxTextLength: 5000,
    supportsTypingIndicator: false,
  }),

  /** LINE signs with HMAC-SHA256 over the raw body, base64-encoded. */
  verifyWebhook(req, account) {
    const secret = account?.credentials.channelSecret;
    if (!secret) return true; // dev mode
    const header = req.headers.get("x-line-signature");
    if (!header) return false;

    const hasher = new Bun.CryptoHasher("sha256", secret);
    hasher.update(req.rawBody);
    const expected = hasher.digest("base64");
    return expected === header;
  },

  parseInbound(rawBody) {
    const body = JSON.parse(rawBody);
    const out: NormalizedMessage[] = [];
    for (const ev of body.events ?? []) {
      if (ev.type !== "message") continue;
      const m = ev.message ?? {};
      const type: MessageType =
        m.type === "text" ? "text"
        : ["image", "video", "audio", "sticker", "location"].includes(m.type) ? m.type
        : m.type === "file" ? "file"
        : "unknown";

      out.push({
        channelType: "line",
        accountExternalId: String(body.destination ?? "line-default"),
        externalUserId: String(ev.source?.userId ?? ev.source?.groupId ?? "unknown"),
        externalMessageId: String(m.id ?? ev.webhookEventId),
        direction: "inbound",
        type,
        body: m.text ?? "",
        attachments: type === "text" ? [] : [{ type, name: m.fileName }],
        timestamp: ev.timestamp ?? Date.now(),
        // The reply token is single-use and expires in ~30s. Real replies from
        // an agent inbox are almost always push messages instead.
        rawPayload: { ...ev, replyToken: ev.replyToken },
      });
    }
    return out;
  },

  async send(account, out): Promise<SendResult> {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.credentials.accessToken}`,
      },
      body: JSON.stringify({
        to: out.to,
        messages: [{ type: "text", text: out.body }],
      }),
    });
    if (res.ok) return { ok: true, externalMessageId: res.headers.get("x-line-request-id") ?? undefined };
    const json: any = await res.json().catch(() => ({}));
    return { ok: false, error: json.message ?? `HTTP ${res.status}` };
  },
};

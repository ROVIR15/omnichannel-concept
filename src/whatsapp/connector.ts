// WhatsApp Cloud API. Arrives on the shared Meta webhook as
// entry[].changes[].value.messages[]; messengerConnector.parseInbound
// dispatches here on object === "whatsapp_business_account".

import { GRAPH, baseCaps, messengerConnector, metaAttachmentType } from "../connectors/meta";
import type { ChannelConnector, MessageType, NormalizedMessage, SendResult } from "../types";
import { META_RATE_LIMIT_CODES, gateOutbound } from "./outbound";

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

  // Same app, same handshake and signature. Wrapped rather than referenced:
  // meta.ts imports this module, so messengerConnector may not exist yet at load.
  handleVerification: (req) => messengerConnector.handleVerification!(req),
  verifyWebhook: (req, account) => messengerConnector.verifyWebhook(req, account),

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
    const gate = gateOutbound();
    if (!gate.ok) return { ok: false, error: gate.error };

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
    if (res.ok) return { ok: true, externalMessageId: json.messages?.[0]?.id };

    const message = json.error?.message ?? `HTTP ${res.status}`;
    return {
      ok: false,
      error: META_RATE_LIMIT_CODES.has(json.error?.code) ? `rate limited by Meta: ${message}` : message,
    };
  },
};

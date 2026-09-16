// Email, treated as just another channel. Inbound arrives as a parsed webhook
// from whichever provider handles the mailbox (Postmark, SendGrid, SES+Lambda);
// this connector accepts a provider-neutral shape so swapping is cheap.

import type { ChannelConnector, NormalizedMessage, SendResult } from "../types";
import { sendGmail } from "../integrations/gmail";

export const emailConnector: ChannelConnector = {
  channelType: () => "email",

  credentialFields: () => [
    { key: "inboundSecret", label: "Inbound Webhook Secret", secret: true, help: "You invent this; add it as ?secret=… on the webhook URL you give your provider." },
    { key: "apiUrl", label: "Outbound API URL", secret: false, help: "e.g. https://api.postmarkapp.com/email — blank means outbound only logs." },
    { key: "apiToken", label: "Outbound API Token", secret: true },
  ],

  capabilities: () => ({
    supportsRichText: true, // the only channel here with real HTML
    supportsTemplates: false,
    hasSessionWindow: false,
    sessionWindowHours: 0,
    mediaTypes: ["image", "file", "audio", "video"],
    maxTextLength: 100_000,
    supportsTypingIndicator: false,
  }),

  /** Providers differ; a shared secret in the URL or a header covers all of them. */
  verifyWebhook(req, account) {
    const secret = account?.credentials.inboundSecret;
    if (!secret) return true; // dev mode
    return (
      req.url.searchParams.get("secret") === secret ||
      req.headers.get("x-inbound-secret") === secret
    );
  },

  parseInbound(rawBody) {
    const p = JSON.parse(rawBody);
    const from: string = p.from ?? p.From ?? p.sender ?? "unknown@example.com";
    const to: string = p.to ?? p.To ?? process.env.EMAIL_ADDRESS ?? "support@example.com";

    // Threading: In-Reply-To / References beat subject matching, which breaks
    // the moment someone's client localises "Re:".
    const threadHint: string =
      p.inReplyTo ?? p.InReplyTo ?? p.references ?? p.References ?? p.messageId ?? p.MessageID ?? "";

    const msg: NormalizedMessage = {
      channelType: "email",
      accountExternalId: String(to).toLowerCase(),
      externalUserId: String(from).toLowerCase(),
      externalMessageId: String(p.messageId ?? p.MessageID ?? crypto.randomUUID()),
      direction: "inbound",
      type: "text",
      body: p.text ?? p.TextBody ?? p.html ?? p.HtmlBody ?? "",
      attachments: (p.attachments ?? p.Attachments ?? []).map((a: any) => ({
        type: "file" as const,
        name: a.name ?? a.Name,
        mimeType: a.contentType ?? a.ContentType,
      })),
      timestamp: Date.parse(p.date ?? p.Date ?? "") || Date.now(),
      senderName: p.fromName ?? p.FromName,
      threadHint: String(threadHint).trim() || undefined,
      rawPayload: p,
    };
    return [msg];
  },

  async send(account, out): Promise<SendResult> {
    if (account.credentials.provider === "gmail") return sendGmail(account, out);

    const url = account.credentials.apiUrl;
    if (!url) {
      console.log(`[email] (no provider configured) would send to ${out.to}: ${out.body}`);
      return { ok: true, externalMessageId: `local-${crypto.randomUUID()}` };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-postmark-server-token": account.credentials.apiToken ?? "",
      },
      body: JSON.stringify({
        From: account.externalId,
        To: out.to,
        Subject: out.threadHint ? `Re: ${out.threadHint}` : "Reply from support",
        TextBody: out.body,
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, externalMessageId: json.MessageID }
      : { ok: false, error: json.Message ?? `HTTP ${res.status}` };
  },
};

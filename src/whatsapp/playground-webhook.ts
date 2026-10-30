import { appendPlaygroundMessage, sessionsForWhatsAppAccount } from "./playground-store";

function verifyToken() {
  return process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || "";
}

function appSecret() {
  return process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || "";
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function validSignature(rawBody: string, signature: string | null) {
  const secret = appSecret();
  if (!secret) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(rawBody);
  return timingSafeEqual(signature.slice(7), hasher.digest("hex"));
}

/** Meta's GET subscription challenge. The token is server-side environment config. */
export function verifyWhatsAppPlaygroundWebhook(url: URL): Response {
  const configured = verifyToken();
  if (!configured) return new Response("WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured", { status: 503 });
  if (
    url.searchParams.get("hub.mode") === "subscribe"
    && url.searchParams.get("hub.verify_token") === configured
  ) {
    return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

/** Parse text messages and fan them out to the browser session configured for this number. */
export function receiveWhatsAppPlaygroundWebhook(rawBody: string, signature: string | null): Response {
  if (!validSignature(rawBody, signature)) return new Response("invalid signature", { status: 401 });

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  if (payload.object !== "whatsapp_business_account") {
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  for (const entry of payload.entry ?? []) {
    const wabaId = String(entry.id ?? "");
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = String(value.metadata?.phone_number_id ?? "");
      if (!phoneNumberId) continue;
      const businessNumber = String(value.metadata?.display_phone_number ?? phoneNumberId);
      const contactNames = new Map(
        (value.contacts ?? []).map((contact: any) => [String(contact.wa_id), contact.profile?.name]),
      );

      for (const message of value.messages ?? []) {
        if (message.type !== "text" || !message.text?.body) continue;
        const sender = String(message.from ?? "");
        const senderLabel = contactNames.get(sender);
        for (const [sessionId] of sessionsForWhatsAppAccount(wabaId, phoneNumberId)) {
          appendPlaygroundMessage(sessionId, {
            id: String(message.id || crypto.randomUUID()),
            direction: "incoming",
            text: String(message.text.body),
            sender: senderLabel ? `${senderLabel} (${sender})` : sender,
            recipient: businessNumber,
            timestamp: Number(message.timestamp) * 1000 || Date.now(),
          });
        }
      }
    }
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

export function whatsappPlaygroundWebhookSettings() {
  return {
    verifyTokenConfigured: Boolean(verifyToken()),
    signatureValidationConfigured: Boolean(appSecret()),
  };
}

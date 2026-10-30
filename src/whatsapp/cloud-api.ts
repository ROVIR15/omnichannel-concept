export interface WhatsAppCloudCredentials {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface WhatsAppCloudSendResult {
  ok: boolean;
  status: number;
  messageId?: string;
  response: unknown;
  error?: string;
}

/** Small, playground-specific Cloud API client. Credentials never leave the server. */
export async function sendWhatsAppText(
  credentials: WhatsAppCloudCredentials,
  to: string,
  text: string,
): Promise<WhatsAppCloudSendResult> {
  const version = process.env.WHATSAPP_GRAPH_API_VERSION
    || process.env.META_GRAPH_VERSION
    || "v21.0";
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(credentials.phoneNumberId)}/messages`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        messageId: payload.messages?.[0]?.id,
        response: payload,
      };
    }
    return {
      ok: false,
      status: response.status,
      response: payload,
      error: payload.error?.message || `WhatsApp Cloud API returned HTTP ${response.status}`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      status: 502,
      response: {},
      error: error instanceof Error ? error.message : "Could not reach the WhatsApp Cloud API",
    };
  }
}

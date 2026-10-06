// The shared vocabulary. Everything below the connector layer speaks only this.

export type ChannelType =
  | "line"
  | "messenger"
  | "instagram"
  | "whatsapp"
  | "wechat"
  | "email";

export type Direction = "inbound" | "outbound";

export type MessageType =
  | "text"
  | "image"
  | "file"
  | "audio"
  | "video"
  | "location"
  | "sticker"
  | "template"
  | "unknown";

export type CredentialSource = "byo_keys" | "oauth_via_us";

/** What a channel can and cannot do. The UI reads this instead of hardcoding
 *  `if (channel === "whatsapp")` in forty places. */
export interface Capabilities {
  supportsRichText: boolean;
  supportsTemplates: boolean;
  hasSessionWindow: boolean;
  sessionWindowHours: number;
  mediaTypes: MessageType[];
  maxTextLength: number;
  supportsTypingIndicator: boolean;
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  help?: string;
  /** Provider-level (your Meta app) rather than per-organisation. */
  appLevel?: boolean;
  /** Shown in an empty input — the value used when nothing is set. */
  placeholder?: string;
}

export interface ChannelAccount {
  id: string;
  orgId: string;
  channelType: ChannelType;
  credentialSource: CredentialSource;
  /** Page id, IG account id, WABA phone number id, LINE bot id, mailbox address. */
  externalId: string;
  displayName: string;
  status: "pending" | "active" | "expired" | "revoked";
  /** In production this is a vault reference, never raw secrets. */
  credentials: Record<string, string>;
}

export interface Attachment {
  type: MessageType;
  /** Provider attachment id. Used to download without storing file bytes. */
  id?: string;
  url?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Base64 payload used only while sending; never persisted or returned. */
  data?: string;
}

/** A message after the connector has stripped away the platform's dialect. */
export interface NormalizedMessage {
  channelType: ChannelType;
  accountExternalId: string;
  externalUserId: string;
  externalMessageId: string;
  direction: Direction;
  type: MessageType;
  body: string;
  attachments: Attachment[];
  timestamp: number;
  senderName?: string;
  /** Email threading, or anything else that needs a conversation hint. */
  threadHint?: string;
  rawPayload: unknown;
}

export interface OutboundMessage {
  to: string;
  type: MessageType;
  body: string;
  subject?: string;
  threadHint?: string;
  /** Provider message id to reply to when the platform has an explicit reply action. */
  replyToMessageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Attachment[];
}

export interface SendResult {
  ok: boolean;
  externalMessageId?: string;
  threadId?: string;
  error?: string;
}

export interface WebhookRequest {
  method: string;
  url: URL;
  headers: Headers;
  rawBody: string;
}

/** Every channel implements exactly this. Nothing else in the app knows
 *  what a Page id or a LINE reply token is. */
export interface ChannelConnector {
  channelType(): ChannelType;
  capabilities(): Capabilities;

  /** Drives the settings UI — what a client must paste to connect this
   *  channel. No hardcoded forms per channel. */
  credentialFields(): CredentialField[];

  /** Webhook handshake (Meta's hub.challenge) — return a Response to short-circuit. */
  handleVerification?(req: WebhookRequest): Response | null;

  /** Reject forged webhooks before any parsing happens. */
  verifyWebhook(req: WebhookRequest, account?: ChannelAccount): boolean;

  /** One webhook delivery can carry many messages. */
  parseInbound(rawBody: string): NormalizedMessage[];

  send(account: ChannelAccount, out: OutboundMessage): Promise<SendResult>;
}

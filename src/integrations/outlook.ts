import { appSetting } from "../settings";
import {
  accountByExternal,
  addMessage,
  createOutlookOAuthState,
  findOrCreateConversation,
  getOrg,
  listAccounts,
  messageExists,
  resolveContact,
  updateAccountConnection,
  updateMessageAttachments,
  upsertAccount,
} from "../store";
import type { Attachment, ChannelAccount, OutboundMessage, SendResult } from "../types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read", "Mail.Send"];
export const MAX_OUTLOOK_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface MicrosoftProfile {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

interface GraphEmailAddress {
  name?: string;
  address?: string;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
  hasAttachments?: boolean;
}

interface GraphMessageList {
  value?: GraphMessage[];
}

interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

interface GraphAttachmentList {
  value?: GraphAttachment[];
}

export interface NormalizedOutlookMessage {
  id: string;
  threadId: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  preview: string;
  bodyText: string;
  receivedAt: number;
  rfcMessageId: string;
  references: string;
  attachments: Attachment[];
}

function config() {
  return {
    clientId: appSetting("microsoft_oauth_client_id"),
    clientSecret: appSetting("microsoft_oauth_client_secret"),
    redirectUri: appSetting("microsoft_oauth_redirect_uri"),
  };
}

function requiredConfig() {
  const values = config();
  const missing = [
    ["clientId", values.clientId],
    ["clientSecret", values.clientSecret],
    ["redirectUri", values.redirectUri],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Outlook OAuth is not configured (${missing.join(", ")})`);
  return values;
}

async function readJson<T>(response: Response): Promise<T> {
  const parsed: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    if (typeof parsed === "object" && parsed !== null) {
      const value = parsed as { error?: string | { message?: string }; error_description?: string };
      detail = value.error_description
        ?? (typeof value.error === "string" ? value.error : value.error?.message)
        ?? detail;
    }
    throw new Error(detail);
  }
  return parsed as T;
}

async function exchangeToken(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  return readJson<TokenResponse>(response);
}

function outlookAccount(orgId: string): ChannelAccount | null {
  return listAccounts(orgId).find(
    (account) => account.channelType === "email" && account.credentials.provider === "outlook",
  ) ?? null;
}

export function outlookConnectionStatus(orgId: string) {
  const account = outlookAccount(orgId);
  const values = config();
  return {
    configured: Boolean(values.clientId && values.clientSecret && values.redirectUri),
    connected: Boolean(account?.credentials.refreshToken || account?.credentials.accessToken),
    emailAddress: account?.externalId ?? null,
    accountId: account?.id ?? null,
  };
}

export function outlookConnectUrl(orgId: string): string {
  if (!getOrg(orgId)) throw new Error("organisation not found");
  const values = requiredConfig();
  const state = createOutlookOAuthState(orgId);
  const params = new URLSearchParams({
    client_id: values.clientId,
    redirect_uri: values.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
  });

  return `${AUTHORITY}/authorize?${params}`;
}

export async function completeOutlookOAuth(orgId: string, code: string): Promise<ChannelAccount> {
  const values = requiredConfig();
  const tokens = await exchangeToken(new URLSearchParams({
    code,
    client_id: values.clientId,
    client_secret: values.clientSecret,
    redirect_uri: values.redirectUri,
    grant_type: "authorization_code",
    scope: SCOPES.join(" "),
  }));
  if (!tokens.access_token) {
    throw new Error(tokens.error_description ?? tokens.error ?? "Microsoft did not return an access token");
  }

  const profileResponse = await fetch(`${GRAPH_API}/me?$select=displayName,mail,userPrincipalName`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await readJson<MicrosoftProfile>(profileResponse);
  const emailAddress = (profile.mail || profile.userPrincipalName || "").trim().toLowerCase();
  if (!emailAddress) throw new Error("Microsoft account did not provide a mailbox address");

  const existing = outlookAccount(orgId) ?? accountByExternal("email", emailAddress);
  if (existing && existing.orgId !== orgId) throw new Error("this Outlook address belongs to another organisation");
  const refreshToken = tokens.refresh_token ?? existing?.credentials.refreshToken;
  if (!refreshToken) throw new Error("Microsoft did not return a refresh token; reconnect Outlook");

  return upsertAccount({
    id: existing?.id,
    orgId,
    channelType: "email",
    credentialSource: "oauth_via_us",
    externalId: emailAddress,
    displayName: `Outlook — ${profile.displayName || emailAddress}`,
    status: "active",
    credentials: {
      ...(existing?.credentials ?? {}),
      provider: "outlook",
      accessToken: tokens.access_token,
      refreshToken,
      tokenExpiry: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    },
  });
}

export function disconnectOutlook(orgId: string): void {
  const account = outlookAccount(orgId);
  if (!account) throw new Error("Outlook is not connected for this organisation");
  // Microsoft does not expose a general refresh-token revocation endpoint for
  // this delegated flow. Removing both tokens locally immediately disconnects
  // the mailbox from this app.
  updateAccountConnection(account.id, { provider: "outlook" }, "revoked");
}

async function accessTokenFor(account: ChannelAccount): Promise<string> {
  const current = account.credentials.accessToken;
  const expiry = Number(account.credentials.tokenExpiry || 0);
  if (current && expiry > Date.now() + 60_000) return current;

  const refreshToken = account.credentials.refreshToken;
  if (!refreshToken) throw new Error("Outlook connection has no refresh token; reconnect Outlook");
  const values = requiredConfig();
  const tokens = await exchangeToken(new URLSearchParams({
    client_id: values.clientId,
    client_secret: values.clientSecret,
    refresh_token: refreshToken,
    redirect_uri: values.redirectUri,
    grant_type: "refresh_token",
    scope: SCOPES.join(" "),
  }));
  if (!tokens.access_token) {
    throw new Error(tokens.error_description ?? tokens.error ?? "could not refresh Outlook access");
  }

  const credentials = {
    ...account.credentials,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    tokenExpiry: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
  };
  account.credentials = credentials;
  upsertAccount({ ...account, credentials });
  return tokens.access_token;
}

async function graphRequest<T>(account: ChannelAccount, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessTokenFor(account);
  const response = await fetch(`${GRAPH_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  return readJson<T>(response);
}

function formatAddress(value?: GraphEmailAddress): string {
  const address = value?.address?.trim() ?? "";
  const name = value?.name?.trim() ?? "";
  return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageHeader(message: GraphMessage, name: string): string {
  return message.internetMessageHeaders
    ?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function attachmentSummary(attachment: GraphAttachment): Attachment | null {
  if (attachment["@odata.type"] !== "#microsoft.graph.fileAttachment" || attachment.isInline) return null;
  return {
    type: "file",
    id: attachment.id,
    name: attachment.name || "attachment",
    mimeType: attachment.contentType || "application/octet-stream",
    size: attachment.size,
  };
}

async function attachmentsFor(account: ChannelAccount, message: GraphMessage): Promise<Attachment[]> {
  if (!message.hasAttachments) return [];
  const query = new URLSearchParams({
    "$top": "50",
    "$select": "id,name,contentType,size,isInline",
  });
  const response = await graphRequest<GraphAttachmentList>(
    account,
    `/me/messages/${encodeURIComponent(message.id)}/attachments?${query}`,
  );
  return (response.value ?? []).map(attachmentSummary).filter((value): value is Attachment => Boolean(value));
}

function normalize(message: GraphMessage, attachments: Attachment[]): NormalizedOutlookMessage {
  const fromAddress = message.from?.emailAddress?.address?.trim().toLowerCase() ?? "";
  const from = formatAddress(message.from?.emailAddress) || fromAddress;
  const recipients = (message.toRecipients ?? []).map((recipient) => formatAddress(recipient.emailAddress)).filter(Boolean);
  const rawBody = message.body?.content ?? message.bodyPreview ?? "";
  const bodyText = message.body?.contentType?.toLowerCase() === "html" ? htmlToText(rawBody) : rawBody;
  return {
    id: message.id,
    threadId: message.conversationId || message.id,
    from,
    fromAddress,
    to: recipients.join(", "),
    subject: message.subject || "(no subject)",
    preview: message.bodyPreview || bodyText.slice(0, 160),
    bodyText,
    receivedAt: Date.parse(message.receivedDateTime ?? "") || Date.now(),
    rfcMessageId: message.internetMessageId ?? "",
    references: messageHeader(message, "References"),
    attachments,
  };
}

export async function syncOutlookInbox(orgId: string): Promise<{
  emailAddress: string;
  synced: number;
  messages: NormalizedOutlookMessage[];
}> {
  const account = outlookAccount(orgId);
  if (!account) throw new Error("Outlook is not connected for this organisation");
  const query = new URLSearchParams({
    "$top": "20",
    "$orderby": "receivedDateTime DESC",
    "$select": [
      "id", "conversationId", "internetMessageId", "subject", "body", "bodyPreview",
      "receivedDateTime", "from", "toRecipients", "internetMessageHeaders", "hasAttachments",
    ].join(","),
  });
  const response = await graphRequest<GraphMessageList>(
    account,
    `/me/mailFolders/inbox/messages?${query}`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } },
  );
  const messages = await Promise.all((response.value ?? []).map(async (message) =>
    normalize(message, await attachmentsFor(account, message)),
  ));
  let synced = 0;

  for (const message of [...messages].sort((a, b) => a.receivedAt - b.receivedAt)) {
    if (messageExists(message.id)) {
      updateMessageAttachments(message.id, message.attachments);
      continue;
    }
    const contact = resolveContact({
      orgId,
      channelType: "email",
      externalUserId: message.fromAddress || message.from,
      displayName: message.from || message.fromAddress,
    });
    const conversation = findOrCreateConversation({
      orgId,
      accountId: account.id,
      contactId: contact.id,
      channelType: "email",
      threadHint: message.threadId,
      subject: message.subject,
    });
    const saved = addMessage({
      conversationId: conversation.id,
      direction: "inbound",
      type: "text",
      body: message.bodyText,
      attachments: message.attachments,
      externalMessageId: message.id,
      sender: message.from,
      recipient: message.to || account.externalId,
      rfcMessageId: message.rfcMessageId,
      references: message.references,
      status: "delivered",
      createdAt: message.receivedAt,
    });
    if (saved) synced++;
  }

  return { emailAddress: account.externalId, synced, messages };
}

export async function downloadOutlookAttachment(
  orgId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ bytes: ArrayBuffer; filename: string; mimeType: string }> {
  const account = outlookAccount(orgId);
  if (!account) throw new Error("Outlook is not connected for this organisation");
  const attachment = await graphRequest<GraphAttachment>(
    account,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (attachment["@odata.type"] !== "#microsoft.graph.fileAttachment" || !attachment.contentBytes) {
    throw new Error("attachment is not a downloadable file");
  }
  const bytes = Uint8Array.from(Buffer.from(attachment.contentBytes, "base64")).buffer;
  if (bytes.byteLength > MAX_OUTLOOK_ATTACHMENT_BYTES) throw new Error("attachment exceeds the 10 MB download limit");
  return {
    bytes,
    filename: attachment.name || "attachment",
    mimeType: attachment.contentType || "application/octet-stream",
  };
}

export async function sendOutlook(account: ChannelAccount, out: OutboundMessage): Promise<SendResult> {
  if (account.credentials.provider !== "outlook") {
    return { ok: false, error: "account is not connected to Outlook" };
  }
  try {
    const token = await accessTokenFor(account);
    const attachments = (out.attachments ?? []).map((attachment) => {
      if (!attachment.data) throw new Error(`attachment ${attachment.name ?? "file"} has no data`);
      return {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: attachment.name ?? "attachment",
        contentType: attachment.mimeType ?? "application/octet-stream",
        contentBytes: attachment.data,
      };
    });
    const isReply = Boolean(out.replyToMessageId);
    const endpoint = isReply
      ? `${GRAPH_API}/me/messages/${encodeURIComponent(out.replyToMessageId!)}/reply`
      : `${GRAPH_API}/me/sendMail`;
    const payload = isReply
      ? {
          comment: out.body,
          ...(attachments.length ? { message: { attachments } } : {}),
        }
      : {
          message: {
            subject: out.subject?.trim() || "(no subject)",
            body: { contentType: "Text", content: out.body },
            toRecipients: [{ emailAddress: { address: out.to.trim() } }],
            ...(attachments.length ? { attachments } : {}),
          },
          saveToSentItems: true,
        };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) await readJson(response);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Outlook send failed" };
  }
}

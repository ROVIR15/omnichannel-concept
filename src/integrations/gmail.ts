import { appSetting } from "../settings";
import {
  accountByExternal,
  addMessage,
  createGmailOAuthState,
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

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
export const MAX_GMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_GMAIL_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface GmailProfile {
  emailAddress: string;
}

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailMessageList {
  messages?: GmailMessageRef[];
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailAttachmentBody {
  data?: string;
  size?: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

export interface NormalizedGmailMessage {
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
    clientId: appSetting("google_oauth_client_id"),
    clientSecret: appSetting("google_oauth_client_secret"),
    redirectUri: appSetting("google_oauth_redirect_uri"),
  };
}

function requiredConfig() {
  const values = config();
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Gmail OAuth is not configured (${missing.join(", ")})`);
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
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  return readJson<TokenResponse>(response);
}

function gmailAccount(orgId: string): ChannelAccount | null {
  return listAccounts(orgId).find(
    (account) => account.channelType === "email" && account.credentials.provider === "gmail",
  ) ?? null;
}

export function gmailConnectionStatus(orgId: string) {
  const account = gmailAccount(orgId);
  const values = config();
  return {
    configured: Boolean(values.clientId && values.clientSecret && values.redirectUri),
    connected: Boolean(account?.credentials.refreshToken || account?.credentials.accessToken),
    emailAddress: account?.externalId ?? null,
    accountId: account?.id ?? null,
  };
}

export async function disconnectGmail(orgId: string): Promise<void> {
  const account = gmailAccount(orgId);
  if (!account) throw new Error("Gmail is not connected for this organisation");
  const token = account.credentials.refreshToken || account.credentials.accessToken;

  // Revocation is best-effort: local logout must still complete if Google is
  // temporarily unavailable or the token was already revoked.
  if (token) {
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) console.warn(`[gmail] token revocation returned HTTP ${response.status}`);
    } catch (error: unknown) {
      console.warn("[gmail] token revocation failed", error instanceof Error ? error.message : error);
    }
  }

  updateAccountConnection(account.id, { provider: "gmail" }, "revoked");
}

export function gmailConnectUrl(orgId: string): string {
  if (!getOrg(orgId)) throw new Error("organisation not found");
  const values = requiredConfig();
  const state = createGmailOAuthState(orgId);
  const params = new URLSearchParams({
    client_id: values.clientId,
    redirect_uri: values.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function completeGmailOAuth(orgId: string, code: string): Promise<ChannelAccount> {
  const values = requiredConfig();
  const tokens = await exchangeToken(new URLSearchParams({
    code,
    client_id: values.clientId,
    client_secret: values.clientSecret,
    redirect_uri: values.redirectUri,
    grant_type: "authorization_code",
  }));
  if (!tokens.access_token) throw new Error(tokens.error_description ?? tokens.error ?? "Google did not return an access token");

  const profileResponse = await fetch(`${GMAIL_API}/users/me/profile`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await readJson<GmailProfile>(profileResponse);
  const existing = gmailAccount(orgId) ?? accountByExternal("email", profile.emailAddress);
  if (existing && existing.orgId !== orgId) throw new Error("this Gmail address belongs to another organisation");

  const refreshToken = tokens.refresh_token ?? existing?.credentials.refreshToken;
  if (!refreshToken) throw new Error("Google did not return a refresh token; reconnect and grant access again");

  return upsertAccount({
    id: existing?.id,
    orgId,
    channelType: "email",
    credentialSource: "oauth_via_us",
    externalId: profile.emailAddress.toLowerCase(),
    displayName: `Gmail — ${profile.emailAddress}`,
    status: "active",
    credentials: {
      ...(existing?.credentials ?? {}),
      provider: "gmail",
      accessToken: tokens.access_token,
      refreshToken,
      tokenExpiry: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    },
  });
}

async function accessTokenFor(account: ChannelAccount): Promise<string> {
  const current = account.credentials.accessToken;
  const expiry = Number(account.credentials.tokenExpiry || 0);
  if (current && expiry > Date.now() + 60_000) return current;

  const refreshToken = account.credentials.refreshToken;
  if (!refreshToken) throw new Error("Gmail connection has no refresh token; reconnect Gmail");
  const values = requiredConfig();
  const tokens = await exchangeToken(new URLSearchParams({
    client_id: values.clientId,
    client_secret: values.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }));
  if (!tokens.access_token) throw new Error(tokens.error_description ?? tokens.error ?? "could not refresh Gmail access");

  upsertAccount({
    ...account,
    credentials: {
      ...account.credentials,
      accessToken: tokens.access_token,
      tokenExpiry: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    },
  });
  return tokens.access_token;
}

async function gmailRequest<T>(account: ChannelAccount, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessTokenFor(account);
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return readJson<T>(response);
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

function decodeBase64UrlBytes(value: string): ArrayBuffer {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(Buffer.from(base64, "base64")).buffer;
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
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

function findBody(part: GmailPart | undefined, mimeType: string): string {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const body = findBody(child, mimeType);
    if (body) return body;
  }
  return "";
}

function collectAttachments(part: GmailPart | undefined, output: Attachment[] = []): Attachment[] {
  if (!part) return output;
  if (part.filename) {
    const id = part.body?.attachmentId ?? (part.body?.data && part.partId ? `inline:${part.partId}` : undefined);
    if (id) {
      output.push({
        type: "file",
        id,
        name: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size,
      });
    }
  }
  for (const child of part.parts ?? []) collectAttachments(child, output);
  return output;
}

function emailAddress(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

function normalize(message: GmailMessage): NormalizedGmailMessage {
  const plain = findBody(message.payload, "text/plain");
  const html = plain ? "" : findBody(message.payload, "text/html");
  const bodyText = plain || htmlToText(html) || message.snippet || "";
  const from = header(message.payload, "From");
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    fromAddress: emailAddress(from),
    to: header(message.payload, "To"),
    subject: header(message.payload, "Subject") || "(no subject)",
    preview: message.snippet || bodyText.slice(0, 160),
    bodyText,
    receivedAt: Number(message.internalDate || Date.now()),
    rfcMessageId: header(message.payload, "Message-ID"),
    references: header(message.payload, "References"),
    attachments: collectAttachments(message.payload),
  };
}

export async function syncGmailInbox(orgId: string): Promise<{
  emailAddress: string;
  synced: number;
  messages: NormalizedGmailMessage[];
}> {
  const account = gmailAccount(orgId);
  if (!account) throw new Error("Gmail is not connected for this organisation");
  const list = await gmailRequest<GmailMessageList>(
    account,
    "/users/me/messages?maxResults=20&labelIds=INBOX",
  );
  const messages = await Promise.all(
    (list.messages ?? []).map((item) =>
      gmailRequest<GmailMessage>(account, `/users/me/messages/${encodeURIComponent(item.id)}?format=full`),
    ),
  );
  const normalized = messages.map(normalize);
  let synced = 0;

  for (const message of [...normalized].sort((a, b) => a.receivedAt - b.receivedAt)) {
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
      recipient: message.to,
      rfcMessageId: message.rfcMessageId,
      references: message.references,
      status: "delivered",
      createdAt: message.receivedAt,
    });
    if (saved) synced++;
  }

  return { emailAddress: account.externalId, synced, messages: normalized };
}

function findAttachmentPart(part: GmailPart | undefined, attachmentId: string): GmailPart | null {
  if (!part) return null;
  if (part.body?.attachmentId === attachmentId) return part;
  if (`inline:${part.partId}` === attachmentId && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findAttachmentPart(child, attachmentId);
    if (found) return found;
  }
  return null;
}

function findAttachmentPartByFilename(part: GmailPart | undefined, filename: string): GmailPart | null {
  if (!part) return null;
  if (part.filename === filename && (part.body?.attachmentId || part.body?.data)) return part;
  for (const child of part.parts ?? []) {
    const found = findAttachmentPartByFilename(child, filename);
    if (found) return found;
  }
  return null;
}

export async function downloadGmailAttachment(
  orgId: string,
  messageId: string,
  attachmentId: string,
  expectedFilename?: string,
): Promise<{ bytes: ArrayBuffer; filename: string; mimeType: string }> {
  const account = gmailAccount(orgId);
  if (!account) throw new Error("Gmail is not connected for this organisation");
  const message = await gmailRequest<GmailMessage>(
    account,
    `/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  );
  const part = findAttachmentPart(message.payload, attachmentId)
    ?? (expectedFilename ? findAttachmentPartByFilename(message.payload, expectedFilename) : null);
  if (!part?.filename) throw new Error("attachment not found in this Gmail message");
  if ((part.body?.size ?? 0) > MAX_GMAIL_ATTACHMENT_BYTES) {
    throw new Error("attachment exceeds the 10 MB download limit");
  }

  let data = part.body?.data;
  if (!data && part.body?.attachmentId) {
    const attachment = await gmailRequest<GmailAttachmentBody>(
      account,
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
    );
    data = attachment.data;
  }
  if (!data) throw new Error("Gmail did not return attachment data");
  const bytes = decodeBase64UrlBytes(data);
  if (bytes.byteLength > MAX_GMAIL_ATTACHMENT_BYTES) throw new Error("attachment exceeds the 10 MB download limit");
  return {
    bytes,
    filename: part.filename,
    mimeType: part.mimeType || "application/octet-stream",
  };
}

function safeHeader(value: string, name: string): string {
  if (/\r|\n/.test(value)) throw new Error(`${name} cannot contain a line break`);
  return value.trim();
}

function encodedSubject(value: string): string {
  const safe = safeHeader(value, "subject");
  return /^[\x20-\x7E]*$/.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function mimeFilename(value: string): string {
  const safe = safeHeader(value, "attachment filename").replace(/["\\]/g, "_");
  return safe.replace(/[^\x20-\x7E]/g, "_") || "attachment";
}

function buildMimeMessage(to: string, subject: string, out: OutboundMessage): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${encodedSubject(subject)}`,
    "MIME-Version: 1.0",
  ];
  if (out.inReplyTo) headers.push(`In-Reply-To: ${safeHeader(out.inReplyTo, "In-Reply-To")}`);
  if (out.references) headers.push(`References: ${safeHeader(out.references, "References")}`);

  const attachments = out.attachments ?? [];
  if (!attachments.length) {
    return [...headers, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", out.body].join("\r\n");
  }

  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!attachment.data) throw new Error(`attachment ${attachment.name ?? "file"} has no data`);
    const bytes = Buffer.from(attachment.data, "base64");
    if (bytes.byteLength > MAX_GMAIL_ATTACHMENT_BYTES) throw new Error(`${attachment.name ?? "attachment"} exceeds the 10 MB limit`);
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > MAX_GMAIL_TOTAL_ATTACHMENT_BYTES) throw new Error("attachments exceed the 20 MB total limit");

  const boundary = `omnichannel_${crypto.randomUUID().replaceAll("-", "")}`;
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    out.body,
  ];
  for (const attachment of attachments) {
    const filename = mimeFilename(attachment.name ?? "attachment");
    const mimeType = /^[-\w.+]+\/[-\w.+]+$/.test(attachment.mimeType ?? "")
      ? attachment.mimeType!
      : "application/octet-stream";
    const wrapped = (attachment.data ?? "").match(/.{1,76}/g)?.join("\r\n") ?? "";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      wrapped,
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

export async function sendGmail(account: ChannelAccount, out: OutboundMessage): Promise<SendResult> {
  if (account.credentials.provider !== "gmail") return { ok: false, error: "account is not connected to Gmail" };
  try {
    const to = safeHeader(out.to, "recipient");
    if (!to) throw new Error("recipient is required");
    const subject = out.subject?.trim() || (out.threadHint ? "Re: (no subject)" : "(no subject)");
    const mime = buildMimeMessage(to, subject, out);
    const raw = Buffer.from(mime, "utf8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/g, "");
    const sent = await gmailRequest<GmailMessageRef>(account, "/users/me/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw, ...(out.threadHint ? { threadId: out.threadHint } : {}) }),
    });
    return { ok: true, externalMessageId: sent.id, threadId: sent.threadId };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Gmail send failed" };
  }
}

// Repositories over SQLite. Same function names the in-memory version had,
// so core.ts did not need to learn anything about storage.

import { sqlite, uid } from "./db";
import type { Attachment, ChannelAccount, ChannelType, Direction, MessageType } from "./types";

// ---------- row shapes ----------

export interface Organisation { id: string; name: string; created_at: number }
export interface Contact {
  id: string; org_id: string; display_name: string;
  primary_email: string | null; primary_phone: string | null; created_at: number;
}
export interface ContactIdentity {
  id: string; contact_id: string; org_id: string;
  channel_type: ChannelType; external_user_id: string; verified: number;
}
export interface Conversation {
  id: string; org_id: string; account_id: string; contact_id: string;
  channel_type: ChannelType; status: string; subject: string | null;
  thread_hint: string | null; assignee_id: string | null;
  last_inbound_at: number; last_message_at: number; created_at: number;
}
export interface MessageRow {
  id: string; conversation_id: string; direction: Direction; type: MessageType;
  body: string; attachments: string; external_message_id: string | null;
  sender: string | null; recipient: string | null; rfc_message_id: string | null;
  references_header: string | null;
  status: string; error: string | null; created_at: number;
}

const q = <T>(sql: string) => sqlite.query<T, any[]>(sql);

// ---------- organisations ----------

export function listOrgs(): Organisation[] {
  return q<Organisation>("SELECT * FROM organisations ORDER BY created_at").all();
}

export function getOrg(id: string): Organisation | null {
  return q<Organisation>("SELECT * FROM organisations WHERE id = ?").get(id) ?? null;
}

export function createOrg(name: string): Organisation {
  const org: Organisation = { id: uid(), name, created_at: Date.now() };
  q("INSERT INTO organisations (id, name, created_at) VALUES (?, ?, ?)")
    .run(org.id, org.name, org.created_at);
  return org;
}

export function renameOrg(id: string, name: string) {
  q("UPDATE organisations SET name = ? WHERE id = ?").run(name, id);
}

export function deleteOrg(id: string) {
  q("DELETE FROM organisations WHERE id = ?").run(id);
}

// ---------- channel accounts ----------

function toAccount(r: any): ChannelAccount {
  return {
    id: r.id,
    orgId: r.org_id,
    channelType: r.channel_type,
    credentialSource: r.credential_source,
    externalId: r.external_id,
    displayName: r.display_name,
    status: r.status,
    credentials: JSON.parse(r.credentials || "{}"),
  };
}

export function listAccounts(orgId?: string): ChannelAccount[] {
  const rows = orgId
    ? q<any>("SELECT * FROM channel_accounts WHERE org_id = ? ORDER BY created_at").all(orgId)
    : q<any>("SELECT * FROM channel_accounts ORDER BY created_at").all();
  return rows.map(toAccount);
}

export function getAccount(id: string): ChannelAccount | null {
  const r = q<any>("SELECT * FROM channel_accounts WHERE id = ?").get(id);
  return r ? toAccount(r) : null;
}

/** How an inbound webhook finds its tenant: the platform's own id. */
export function accountByExternal(channelType: ChannelType, externalId: string): ChannelAccount | null {
  const r = q<any>(
    "SELECT * FROM channel_accounts WHERE channel_type = ? AND external_id = ?",
  ).get(channelType, externalId);
  return r ? toAccount(r) : null;
}

export function upsertAccount(a: Omit<ChannelAccount, "id"> & { id?: string }): ChannelAccount {
  const status = Object.values(a.credentials).some(Boolean) ? "active" : "pending";
  if (a.id && getAccount(a.id)) {
    q(`UPDATE channel_accounts SET org_id=?, channel_type=?, credential_source=?,
         external_id=?, display_name=?, status=?, credentials=? WHERE id=?`)
      .run(a.orgId, a.channelType, a.credentialSource, a.externalId,
           a.displayName, status, JSON.stringify(a.credentials), a.id);
    return getAccount(a.id)!;
  }
  const id = a.id ?? uid();
  q(`INSERT INTO channel_accounts
       (id, org_id, channel_type, credential_source, external_id, display_name, status, credentials, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, a.orgId, a.channelType, a.credentialSource, a.externalId,
         a.displayName, status, JSON.stringify(a.credentials), Date.now());
  return getAccount(id)!;
}

export function deleteAccount(id: string) {
  q("DELETE FROM channel_accounts WHERE id = ?").run(id);
}

// ---------- contacts & identities ----------

export function findIdentity(orgId: string, channelType: ChannelType, externalUserId: string) {
  return q<ContactIdentity>(
    "SELECT * FROM contact_identities WHERE org_id = ? AND channel_type = ? AND external_user_id = ?",
  ).get(orgId, channelType, externalUserId) ?? null;
}

export function identityFor(contactId: string, channelType: ChannelType) {
  return q<ContactIdentity>(
    "SELECT * FROM contact_identities WHERE contact_id = ? AND channel_type = ?",
  ).get(contactId, channelType) ?? null;
}

export function getContact(id: string) {
  return q<Contact>("SELECT * FROM contacts WHERE id = ?").get(id) ?? null;
}

/** v1 policy: never auto-merge across channels. An agent merges manually.
 *  Auto-merging on a shared phone number is how one customer ends up seeing
 *  another customer's history. */
export function resolveContact(opts: {
  orgId: string; channelType: ChannelType; externalUserId: string; displayName?: string;
}): Contact {
  const existing = findIdentity(opts.orgId, opts.channelType, opts.externalUserId);
  if (existing) return getContact(existing.contact_id)!;

  const id = uid();
  q("INSERT INTO contacts (id, org_id, display_name, primary_email, primary_phone, created_at) VALUES (?,?,?,?,?,?)")
    .run(id, opts.orgId, opts.displayName || opts.externalUserId,
         opts.channelType === "email" ? opts.externalUserId : null,
         opts.channelType === "whatsapp" ? opts.externalUserId : null,
         Date.now());

  q("INSERT INTO contact_identities (id, contact_id, org_id, channel_type, external_user_id, verified) VALUES (?,?,?,?,?,0)")
    .run(uid(), id, opts.orgId, opts.channelType, opts.externalUserId);

  return getContact(id)!;
}

// ---------- conversations ----------

export function getConversation(id: string) {
  return q<Conversation>("SELECT * FROM conversations WHERE id = ?").get(id) ?? null;
}

export function findOrCreateConversation(opts: {
  orgId: string; accountId: string; contactId: string;
  channelType: ChannelType; threadHint?: string; subject?: string;
}): Conversation {
  if (opts.threadHint) {
    const threaded = q<Conversation>(
      "SELECT * FROM conversations WHERE account_id = ? AND thread_hint = ? AND status != 'closed' LIMIT 1",
    ).get(opts.accountId, opts.threadHint);
    if (threaded) return threaded;
  }

  const open = q<Conversation>(
    "SELECT * FROM conversations WHERE account_id = ? AND contact_id = ? AND status != 'closed' AND thread_hint IS NULL LIMIT 1",
  ).get(opts.accountId, opts.contactId);
  if (open) return open;

  const id = uid();
  q(`INSERT INTO conversations
       (id, org_id, account_id, contact_id, channel_type, status, subject, thread_hint, last_inbound_at, last_message_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?)`)
    .run(id, opts.orgId, opts.accountId, opts.contactId, opts.channelType,
         opts.subject ?? null, opts.threadHint ?? null, Date.now(), Date.now());
  return getConversation(id)!;
}

export function updateConversationThread(id: string, threadHint: string) {
  q("UPDATE conversations SET thread_hint = ? WHERE id = ?").run(threadHint, id);
}

export function listConversations(orgId: string): Conversation[] {
  return q<Conversation>(
    "SELECT * FROM conversations WHERE org_id = ? ORDER BY last_message_at DESC",
  ).all(orgId);
}

/** Test seam: force a conversation's window open or shut. */
export function setLastInboundAt(conversationId: string, at: number) {
  q("UPDATE conversations SET last_inbound_at = ? WHERE id = ?").run(at, conversationId);
}

// ---------- messages ----------

export function addMessage(m: {
  conversationId: string; direction: Direction; type: MessageType; body: string;
  attachments: Attachment[]; externalMessageId?: string; status: string; error?: string;
  sender?: string; recipient?: string; rfcMessageId?: string; references?: string;
  createdAt?: number;
}): MessageRow | null {
  const id = uid();
  const now = m.createdAt ?? Date.now();
  try {
    q(`INSERT INTO messages
         (id, conversation_id, direction, type, body, attachments, external_message_id,
          sender, recipient, rfc_message_id, references_header, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, m.conversationId, m.direction, m.type, m.body,
           JSON.stringify(m.attachments), m.externalMessageId ?? null,
           m.sender ?? null, m.recipient ?? null, m.rfcMessageId ?? null,
           m.references ?? null, m.status, m.error ?? null, now);
  } catch (err: unknown) {
    // Unique index on external_message_id — a retried webhook lands here.
    if (err instanceof Error && err.message.includes("UNIQUE")) return null;
    throw err;
  }

  q(`UPDATE conversations SET last_message_at = MAX(last_message_at, ?)
       ${m.direction === "inbound" ? ", last_inbound_at = MAX(last_inbound_at, ?)" : ""} WHERE id = ?`)
    .run(...(m.direction === "inbound" ? [now, now, m.conversationId] : [now, m.conversationId]));

  return getMessage(id);
}

export function getMessage(id: string) {
  return q<MessageRow>("SELECT * FROM messages WHERE id = ?").get(id) ?? null;
}

export function updateMessage(id: string, patch: { status?: string; error?: string; externalMessageId?: string }) {
  q("UPDATE messages SET status = COALESCE(?, status), error = ?, external_message_id = COALESCE(?, external_message_id) WHERE id = ?")
    .run(patch.status ?? null, patch.error ?? null, patch.externalMessageId ?? null, id);
}

export function messagesOf(conversationId: string): MessageRow[] {
  return q<MessageRow>(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at",
  ).all(conversationId);
}

export function messageExists(externalMessageId: string): boolean {
  return !!q<{ n: number }>("SELECT 1 AS n FROM messages WHERE external_message_id = ?").get(externalMessageId);
}

export function updateMessageAttachments(externalMessageId: string, attachments: Attachment[]) {
  q("UPDATE messages SET attachments = ? WHERE external_message_id = ?")
    .run(JSON.stringify(attachments), externalMessageId);
}

// ---------- Gmail OAuth state -------------------------------------------

export function createGmailOAuthState(orgId: string): string {
  const state = `${uid()}${uid()}`.replaceAll("-", "");
  const expiresAt = Date.now() + 10 * 60_000;
  q("DELETE FROM gmail_oauth_states WHERE expires_at < ?").run(Date.now());
  q("INSERT INTO gmail_oauth_states (state, org_id, expires_at) VALUES (?, ?, ?)")
    .run(state, orgId, expiresAt);
  return state;
}

export function consumeGmailOAuthState(state: string): string | null {
  const row = q<{ org_id: string; expires_at: number }>(
    "SELECT org_id, expires_at FROM gmail_oauth_states WHERE state = ?",
  ).get(state);
  q("DELETE FROM gmail_oauth_states WHERE state = ?").run(state);
  return row && row.expires_at >= Date.now() ? row.org_id : null;
}

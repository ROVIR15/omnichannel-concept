// The pipeline every inbound message walks, and the guard every outbound
// message passes. Nothing here knows which platform it is talking to.

import { connectorFor } from "./registry";
import {
  accountByExternal, addMessage, findOrCreateConversation, getAccount, getContact,
  getConversation, identityFor, listConversations, messageExists, messagesOf,
  resolveContact, updateMessage,
  updateConversationThread,
} from "./store";
import type { Attachment, NormalizedMessage } from "./types";

export interface IngestResult { accepted: number; duplicates: number; skipped: number }

export function ingest(messages: NormalizedMessage[]): IngestResult {
  const result: IngestResult = { accepted: 0, duplicates: 0, skipped: 0 };

  for (const m of messages) {
    // 1. Idempotency — platforms retry, and retries must not double-post.
    if (messageExists(m.externalMessageId)) { result.duplicates++; continue; }

    // 2. Which connected account did this land on? This is also how a
    //    webhook finds its tenant — the platform id maps to exactly one org.
    const account = accountByExternal(m.channelType, m.accountExternalId);
    if (!account) {
      console.warn(`[core] no account for ${m.channelType}/${m.accountExternalId}`);
      result.skipped++;
      continue;
    }

    // 3. Identity resolution, then conversation, then persist.
    const contact = resolveContact({
      orgId: account.orgId,
      channelType: m.channelType,
      externalUserId: m.externalUserId,
      displayName: m.senderName,
    });

    const conv = findOrCreateConversation({
      orgId: account.orgId,
      accountId: account.id,
      contactId: contact.id,
      channelType: m.channelType,
      threadHint: m.threadHint,
    });

    const saved = addMessage({
      conversationId: conv.id,
      direction: "inbound",
      type: m.type,
      body: m.body,
      attachments: m.attachments,
      externalMessageId: m.externalMessageId,
      status: "delivered",
    });

    // 4. Routing would go here (rules, round-robin, skills).
    if (saved) result.accepted++; else result.duplicates++;
  }

  return result;
}

/** Reject impossible sends before the platform does, with a reason a human
 *  can act on. This is what capabilities() is for. */
export function checkSendable(conversationId: string, text: string) {
  const conv = getConversation(conversationId);
  if (!conv) return { ok: false as const, reason: "conversation not found" };

  const account = getAccount(conv.account_id);
  if (!account) return { ok: false as const, reason: "channel account missing" };

  const caps = connectorFor(conv.channel_type).capabilities();

  if (text.length > caps.maxTextLength) {
    return { ok: false as const, reason: `too long for ${conv.channel_type} (max ${caps.maxTextLength})` };
  }

  if (caps.hasSessionWindow) {
    const limitMs = caps.sessionWindowHours * 3600_000;
    if (!conv.last_inbound_at || Date.now() - conv.last_inbound_at > limitMs) {
      return {
        ok: false as const,
        reason: caps.supportsTemplates
          ? `${caps.sessionWindowHours}h window closed — use an approved template`
          : `${caps.sessionWindowHours}h window closed`,
      };
    }
  }

  return { ok: true as const, conv, account };
}

export async function reply(conversationId: string, text: string, attachments: Attachment[] = []) {
  const check = checkSendable(conversationId, text);
  if (!check.ok) return { ok: false, error: check.reason };

  const { conv, account } = check;
  if (attachments.length && !(account.channelType === "email" && account.credentials.provider === "gmail")) {
    return { ok: false, error: "attachments are currently supported only for Gmail" };
  }
  const identity = identityFor(conv.contact_id, conv.channel_type);
  if (!identity) return { ok: false, error: "no channel identity for contact" };
  const previous = messagesOf(conv.id).filter((message) => message.direction === "inbound").at(-1);
  const references = [previous?.references_header, previous?.rfc_message_id].filter(Boolean).join(" ");

  const pending = addMessage({
    conversationId: conv.id,
    direction: "outbound",
    type: "text",
    body: text,
    attachments: attachments.map(({ data: _data, ...attachment }) => attachment),
    sender: account.externalId,
    recipient: identity.external_user_id,
    status: "queued",
  })!;

  const res = await connectorFor(conv.channel_type).send(account, {
    to: identity.external_user_id,
    type: "text",
    body: text,
    subject: conv.subject
      ? ((previous || conv.thread_hint) && !/^re:/i.test(conv.subject) ? `Re: ${conv.subject}` : conv.subject)
      : undefined,
    threadHint: conv.thread_hint ?? undefined,
    inReplyTo: previous?.rfc_message_id ?? undefined,
    references: references || undefined,
    attachments,
  });

  updateMessage(pending.id, {
    status: res.ok ? "sent" : "failed",
    error: res.error,
    externalMessageId: res.externalMessageId,
  });
  if (res.threadId && !conv.thread_hint) updateConversationThread(conv.id, res.threadId);

  return {
    ok: res.ok,
    error: res.error,
    conversationId: conv.id,
    externalMessageId: res.externalMessageId,
    threadId: res.threadId,
  };
}

/** Agent-initiated conversation. Note it deliberately skips checkSendable's
 *  session-window rule only when the channel has none — on WhatsApp an
 *  outbound-first message legitimately requires a template. */
export async function startConversation(opts: {
  accountId: string; to: string; name?: string; subject?: string; text?: string;
  attachments?: Attachment[];
}) {
  const account = getAccount(opts.accountId);
  if (!account) return { ok: false as const, error: "channel account not found" };
  if (!opts.to.trim()) return { ok: false as const, error: "recipient is required" };

  const contact = resolveContact({
    orgId: account.orgId,
    channelType: account.channelType,
    externalUserId: opts.to.trim(),
    displayName: opts.name?.trim() || undefined,
  });

  const conv = findOrCreateConversation({
    orgId: account.orgId,
    accountId: account.id,
    contactId: contact.id,
    channelType: account.channelType,
    subject: opts.subject,
  });

  if (!opts.text?.trim() && !opts.attachments?.length) return { ok: true as const, conversationId: conv.id };

  const caps = connectorFor(account.channelType).capabilities();
  if (caps.hasSessionWindow && !conv.last_inbound_at) {
    // Be honest rather than letting Meta reject it a second later.
    return {
      ok: false as const,
      conversationId: conv.id,
      error: `${account.channelType}: cannot message first outside a ${caps.sessionWindowHours}h window — an approved template is required`,
    };
  }

  const sent = await reply(conv.id, opts.text ?? "", opts.attachments);
  return { ...sent, conversationId: conv.id };
}

/** Shape the inbox UI consumes. */
export function inbox(orgId: string) {
  return listConversations(orgId).map((c) => {
    const msgs = messagesOf(c.id);
    const caps = connectorFor(c.channel_type).capabilities();
    const windowOpen =
      !caps.hasSessionWindow ||
      (c.last_inbound_at > 0 && Date.now() - c.last_inbound_at < caps.sessionWindowHours * 3600_000);

    return {
      id: c.id,
      accountId: c.account_id,
      channel: c.channel_type,
      contact: getContact(c.contact_id)?.display_name ?? "unknown",
      status: c.status,
      subject: c.subject,
      threadId: c.thread_hint,
      windowOpen,
      lastMessageAt: c.last_message_at,
      preview: msgs.at(-1)?.body.slice(0, 80) ?? "",
      messages: msgs.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        type: m.type,
        status: m.status,
        error: m.error,
        sender: m.sender,
        recipient: m.recipient,
        externalMessageId: m.external_message_id,
        attachments: JSON.parse(m.attachments || "[]") as Attachment[],
        createdAt: m.created_at,
      })),
    };
  });
}

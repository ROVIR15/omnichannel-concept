// HTTP surface: webhooks in, console + agent API out.
// Note the shape of every webhook handler: verify, hand off, respond fast.

import { ingest, inbox, reply, startConversation } from "./core";
import { signingSecrets } from "./connectors/meta";
import { connectorFor } from "./registry";
import { seedIfEmpty } from "./seed";
import { APP_SETTING_FIELDS, maskedAppSettings, saveAppSettings } from "./settings";
import {
  completeGmailOAuth,
  disconnectGmail,
  downloadGmailAttachment,
  gmailConnectionStatus,
  gmailConnectUrl,
  syncGmailInbox,
} from "./integrations/gmail";
import {
  accountByExternal, createOrg, deleteAccount, deleteOrg, getAccount, listAccounts,
  listOrgs, renameOrg, upsertAccount, consumeGmailOAuthState,
} from "./store";
import type { Attachment, ChannelAccount, ChannelType, WebhookRequest } from "./types";

seedIfEmpty();

const PORT = Number(process.env.PORT ?? 3000);
const CHANNELS: ChannelType[] = ["messenger", "instagram", "whatsapp", "line", "email"];

async function body<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status, headers: { "content-type": "application/json" },
  });

const page = (file: string) =>
  new Response(Bun.file(new URL(`./web/${file}`, import.meta.url)), {
    headers: { "content-type": "text/html" },
  });

/** Never send stored secrets back to the browser — only whether they exist. */
function maskAccount(a: ChannelAccount) {
  const fields = connectorFor(a.channelType).credentialFields();
  return {
    id: a.id,
    orgId: a.orgId,
    channelType: a.channelType,
    credentialSource: a.credentialSource,
    externalId: a.externalId,
    displayName: a.displayName,
    status: a.status,
    capabilities: connectorFor(a.channelType).capabilities(),
    fields: fields.map((f) => ({
      ...f,
      value: f.secret ? "" : (a.credentials[f.key] ?? ""),
      configured: Boolean(a.credentials[f.key]),
    })),
  };
}

/** A blank secret from the form means "leave it alone", not "erase it".
 *  Otherwise every save would wipe the tokens the UI never received. */
function mergeCredentials(existing: Record<string, string>, incoming: Record<string, string>, channelType: ChannelType) {
  const merged = { ...existing };
  for (const f of connectorFor(channelType).credentialFields()) {
    const v = incoming[f.key];
    if (v === undefined) continue;
    if (f.secret && v === "") continue;
    merged[f.key] = v;
  }
  return merged;
}

async function handleWebhook(channel: ChannelType, req: Request, url: URL) {
  const connector = connectorFor(channel);
  const wreq: WebhookRequest = {
    method: req.method, url, headers: req.headers, rawBody: await req.text(),
  };

  // Meta's subscribe handshake.
  const verification = connector.handleVerification?.(wreq);
  if (verification) return verification;

  let parsed;
  try {
    parsed = connector.parseInbound(wreq.rawBody);
  } catch (err) {
    // Never 500 at a platform — it will retry for hours. Log and move on.
    console.error(`[${channel}] parse failed`, err);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  // Signature verification needs the account, and the account is identified by
  // the payload — so parse first, then verify against the resolved account.
  const first = parsed[0];
  const account = first ? accountByExternal(first.channelType, first.accountExternalId) : undefined;
  // Diagnostic capture: set DEBUG_WEBHOOK=1 to dump raw deliveries for
  // inspection. Never enable in production — payloads contain user content.
  if (process.env.DEBUG_WEBHOOK === "1") {
    await Bun.write(
      `/tmp/webhook-${channel}-${Date.now()}.json`,
      JSON.stringify({
        signature: wreq.headers.get("x-hub-signature-256"),
        signature1: wreq.headers.get("x-hub-signature"),
        rawBody: wreq.rawBody,
      }, null, 2),
    );
  }

  if (!connector.verifyWebhook(wreq, account ?? undefined)) {
    // Say enough to diagnose which key Meta actually signed with.
    let object = "?";
    try { object = JSON.parse(wreq.rawBody).object ?? "?"; } catch {}
    console.warn(
      `[${channel}] signature rejected — object=${object}` +
      ` externalId=${first?.accountExternalId ?? "?"}` +
      ` tried=[${signingSecrets().map((s) => s.name).join(", ") || "none configured"}]`,
    );
    return new Response("invalid signature", { status: 401 });
  }

  const result = ingest(parsed);

  // A delivery that carries no messages is normal (read receipts, edits,
  // delivery notices). Say which kinds arrived, so a silent inbox is
  // diagnosable without capturing raw payloads.
  if (parsed.length === 0) {
    let kinds: string[] = [];
    try {
      const b = JSON.parse(wreq.rawBody);
      for (const e of b.entry ?? []) {
        for (const ev of e.messaging ?? []) {
          kinds.push(...Object.keys(ev).filter((k) => k !== "timestamp" && k !== "sender" && k !== "recipient"));
        }
        for (const c of e.changes ?? []) kinds.push(`change:${c.field}`);
      }
    } catch {}
    console.log(`[${channel}] no messages in delivery — event types: ${kinds.join(", ") || "(none)"}`);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  console.log(`[${channel}] ${JSON.stringify(result)}`);
  return new Response("EVENT_RECEIVED", { status: 200 });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/health") return json({ ok: true });

    // --- Pages ----------------------------------------------------------
    if (path === "/" || path === "/settings" || path === "/console") return page("index.html");
    if (path === "/inbox") return page("inbox.html");

    // --- Webhooks -------------------------------------------------------
    // One Meta endpoint serves Messenger, Instagram and WhatsApp; the parser
    // branches on payload.object.
    if (path === "/webhooks/meta") return handleWebhook("messenger", req, url);
    if (path === "/webhooks/line") return handleWebhook("line", req, url);
    if (path === "/webhooks/email") return handleWebhook("email", req, url);

    // --- Organisations --------------------------------------------------
    if (path === "/api/orgs" && method === "GET") return json(listOrgs());

    if (path === "/api/orgs" && method === "POST") {
      const b = await body<{ name?: string }>(req);
      if (!b?.name?.trim()) return json({ error: "name is required" }, 400);
      return json(createOrg(b.name.trim()), 201);
    }

    const orgMatch = path.match(/^\/api\/orgs\/([^/]+)$/);
    if (orgMatch) {
      const id = orgMatch[1]!;
      if (method === "PATCH") {
        const b = await body<{ name?: string }>(req);
        if (!b?.name?.trim()) return json({ error: "name is required" }, 400);
        renameOrg(id, b.name.trim());
        return json({ ok: true });
      }
      if (method === "DELETE") {
        if (listOrgs().length <= 1) return json({ error: "cannot delete the last organisation" }, 400);
        deleteOrg(id);
        return json({ ok: true });
      }
    }

    // --- App settings (the Meta app you own as the provider) -------------
    if (path === "/api/settings" && method === "GET") return json(maskedAppSettings());

    if (path === "/api/settings" && method === "POST") {
      const b = await body<Record<string, string>>(req);
      if (!b) return json({ error: "invalid JSON body" }, 400);
      // Blank secret = leave unchanged.
      const patch: Record<string, string> = {};
      for (const f of APP_SETTING_FIELDS) {
        const v = b[f.key];
        if (v === undefined) continue;
        if (f.secret && v === "") continue;
        patch[f.key] = v;
      }
      saveAppSettings(patch);
      return json({ ok: true });
    }

    // --- Gmail integration ----------------------------------------------
    if (path === "/api/integrations/gmail/connect" && method === "GET") {
      const orgId = url.searchParams.get("org");
      if (!orgId) return json({ error: "org query parameter is required" }, 400);
      try {
        return Response.redirect(gmailConnectUrl(orgId), 302);
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : "could not start Gmail OAuth" }, 400);
      }
    }

    if (path === "/api/integrations/gmail/callback" && method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const orgId = state ? consumeGmailOAuthState(state) : null;
      if (!orgId) return json({ error: "invalid or expired OAuth state" }, 400);
      const destination = new URL("/inbox", url.origin);
      destination.searchParams.set("org", orgId);
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        destination.searchParams.set("gmail_error", oauthError);
        return Response.redirect(destination, 302);
      }
      const code = url.searchParams.get("code");
      if (!code) return json({ error: "Google did not return an authorization code" }, 400);
      try {
        await completeGmailOAuth(orgId, code);
        destination.searchParams.set("gmail", "connected");
      } catch (error: unknown) {
        destination.searchParams.set(
          "gmail_error",
          error instanceof Error ? error.message : "Gmail connection failed",
        );
      }
      return Response.redirect(destination, 302);
    }

    if (path === "/api/integrations/gmail/status" && method === "GET") {
      const orgId = url.searchParams.get("org");
      if (!orgId) return json({ error: "org query parameter is required" }, 400);
      return json(gmailConnectionStatus(orgId));
    }

    if (path === "/api/integrations/gmail/disconnect" && method === "POST") {
      const b = await body<{ orgId?: string }>(req);
      if (!b?.orgId) return json({ error: "orgId is required" }, 400);
      try {
        await disconnectGmail(b.orgId);
        return json({ ok: true });
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : "Gmail logout failed" }, 400);
      }
    }

    if (path === "/api/integrations/gmail/messages" && method === "GET") {
      const orgId = url.searchParams.get("org");
      if (!orgId) return json({ error: "org query parameter is required" }, 400);
      try {
        return json(await syncGmailInbox(orgId));
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : "Gmail inbox sync failed" }, 502);
      }
    }

    const gmailAttachmentMatch = path.match(/^\/api\/integrations\/gmail\/attachments\/([^/]+)\/([^/]+)$/);
    if (gmailAttachmentMatch && method === "GET") {
      const orgId = url.searchParams.get("org");
      if (!orgId) return json({ error: "org query parameter is required" }, 400);
      try {
        const attachment = await downloadGmailAttachment(
          orgId,
          decodeURIComponent(gmailAttachmentMatch[1]!),
          decodeURIComponent(gmailAttachmentMatch[2]!),
          url.searchParams.get("name") ?? undefined,
        );
        const previewable = new Set([
          "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
          "application/pdf",
        ]).has(attachment.mimeType.toLowerCase());
        const disposition = url.searchParams.get("inline") === "1" && previewable
          ? "inline"
          : "attachment";
        return new Response(attachment.bytes, {
          headers: {
            "content-type": attachment.mimeType,
            "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : "attachment download failed" }, 404);
      }
    }

    if (path === "/api/integrations/gmail/send" && method === "POST") {
      const b = await body<{
        orgId?: string; to?: string; subject?: string; bodyText?: string; attachments?: Attachment[];
      }>(req);
      if (!b?.orgId || !b.to?.trim() || !b.subject?.trim() || (!b.bodyText?.trim() && !b.attachments?.length)) {
        return json({ error: "orgId, to, subject, and a message or attachment are required" }, 400);
      }
      const status = gmailConnectionStatus(b.orgId);
      if (!status.connected || !status.accountId) return json({ error: "Gmail is not connected" }, 400);
      const result = await startConversation({
        accountId: status.accountId,
        to: b.to,
        subject: b.subject,
        text: b.bodyText ?? "",
        attachments: b.attachments,
      });
      return json(result, result.ok ? 201 : 400);
    }

    // --- Channel accounts ------------------------------------------------
    if (path === "/api/channels" && method === "GET") {
      const orgId = url.searchParams.get("org");
      const accounts = listAccounts(orgId ?? undefined).map(maskAccount);
      return json({
        accounts,
        catalogue: CHANNELS.map((c) => ({
          channelType: c,
          capabilities: connectorFor(c).capabilities(),
          fields: connectorFor(c).credentialFields(),
        })),
      });
    }

    if (path === "/api/channels" && method === "POST") {
      const b = await body<any>(req);
      if (!b) return json({ error: "invalid JSON body" }, 400);
      if (!b.orgId || !b.channelType || !b.externalId?.trim()) {
        return json({ error: "orgId, channelType and externalId are required" }, 400);
      }
      const existing = b.id ? getAccount(b.id) : null;
      try {
        const saved = upsertAccount({
          id: b.id,
          orgId: b.orgId,
          channelType: b.channelType,
          credentialSource: b.credentialSource ?? "byo_keys",
          externalId: String(b.externalId).trim(),
          displayName: b.displayName?.trim() || b.channelType,
          status: "pending",
          credentials: mergeCredentials(existing?.credentials ?? {}, b.credentials ?? {}, b.channelType),
        });
        return json(maskAccount(saved));
      } catch (err: any) {
        if (String(err?.message).includes("UNIQUE")) {
          return json({ error: `that ${b.channelType} id is already connected to another organisation` }, 409);
        }
        throw err;
      }
    }

    const chanMatch = path.match(/^\/api\/channels\/([^/]+)$/);
    if (chanMatch && method === "DELETE") {
      deleteAccount(chanMatch[1]!);
      return json({ ok: true });
    }

    // --- Inbox -----------------------------------------------------------
    if (path === "/api/conversations" && method === "GET") {
      const orgId = url.searchParams.get("org");
      if (!orgId) return json({ error: "org query parameter is required" }, 400);
      return json(inbox(orgId));
    }

    if (path === "/api/conversations" && method === "POST") {
      const b = await body<any>(req);
      if (!b) return json({ error: "invalid JSON body" }, 400);
      const res = await startConversation({
        accountId: b.accountId, to: b.to, name: b.name, subject: b.subject, text: b.text,
      });
      return json(res, res.ok ? 201 : 400);
    }

    const replyMatch = path.match(/^\/api\/conversations\/([^/]+)\/reply$/);
    if (replyMatch && method === "POST") {
      const b = await body<{ text?: string; attachments?: Attachment[] }>(req);
      if (!b || (!b.text?.trim() && !b.attachments?.length)) return json({ error: "text or an attachment is required" }, 400);
      const res = await reply(replyMatch[1]!, b.text ?? "", b.attachments);
      return json(res, res.ok ? 200 : 400);
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`omnichannel concept listening on http://localhost:${server.port}`);
console.log(`  console  → http://localhost:${server.port}/`);
console.log(`  inbox    → http://localhost:${server.port}/inbox`);
console.log(`  webhooks → /webhooks/meta  /webhooks/line  /webhooks/email`);

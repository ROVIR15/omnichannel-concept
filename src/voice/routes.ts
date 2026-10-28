// Voice endpoints: a token for the browser, the webhooks Twilio calls, and
// each organisation's phone numbers. Test-grade on purpose — a call to an
// organisation's number rings every one of its people whose status is
// "available"; the platform number (Settings) rings everyone available.

import { voiceDeps, type VoiceUser } from "./context";
import { addNumber, callerIdFor, checkPendingNumbers, listNumbers, orgForNumber, removeNumber } from "./numbers";
import { offerCall, parseOutcome, RELAY_END_PATH, RELAY_PATH } from "./relay";
import {
  buildCallTranscript, callOrgId, canSeeCall, listCalls, recordCall, recordTranscriptionEvent, trackLabels, type Direction,
} from "./transcripts";
import {
  connectRelay, dialClients, dialNumber, missingForCalls, say, sayError, startTranscription, transcriptionEnabled, twiml,
  validTwilioSignature, voiceConfig, voiceToken,
} from "./twilio";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

/** The URL Twilio called, as Twilio saw it — needed for the signature. */
function publicUrl(req: Request, url: URL): string {
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

async function twilioParams(req: Request, url: URL): Promise<Record<string, string> | null> {
  const form = await req.formData().catch(() => null);
  const params: Record<string, string> = {};
  form?.forEach((v, k) => { params[k] = String(v); });
  return validTwilioSignature(publicUrl(req, url), params, req.headers.get("x-twilio-signature")) ? params : null;
}

/** Save the call and, when the transcription flag is on, return the TwiML
 *  that starts transcribing it. */
function beginCall(
  req: Request, url: URL, p: Record<string, string>, direction: Direction,
  call: { orgId: string | null; businessNumber: string },
): string {
  const transcribe = transcriptionEnabled();
  recordCall(p, direction, { ...call, transcribing: transcribe });
  return transcribe ? transcriptionStart(req, url, direction) : "";
}

function transcriptionStart(req: Request, url: URL, direction: Direction): string {
  const callback = new URL("/webhooks/twilio/transcription", publicUrl(req, url)).href;
  return startTranscription(callback, trackLabels(direction));
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** Admins manage their own organisation's numbers; operators any. Checked
 *  here so the package is safe on its own, whatever the host checks first. */
const managesOrg = (user: VoiceUser, orgId: string) =>
  user.role === "operator" || (user.role === "admin" && user.orgId === orgId);
const forbidden = () => json({ error: "you don't have access to this organisation's numbers" }, 403);

export async function handleVoiceRoutes(req: Request, url: URL, user: VoiceUser | null): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/voice/token" && method === "GET" && user) {
    const missing = missingForCalls();
    if (missing.length) return json({ error: `Twilio settings missing: ${missing.join(", ")}` }, 400);
    return json({ token: voiceToken(user.id), identity: user.id, phoneNumber: callerIdFor(user) });
  }

  if (path === "/webhooks/twilio/voice" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });

    // From the browser (the TwiML App): dial the number the agent typed,
    // showing their organisation's number.
    if (p.From?.startsWith("client:")) {
      const to = (p.To ?? "").replace(/[\s()-]/g, "");
      const agent = voiceDeps().users.get(p.From.slice("client:".length));
      const callerId = callerIdFor(agent);
      console.log(`[voice] outbound ${p.From} → ${to} as ${callerId} (${p.CallSid})`);
      if (!E164.test(to)) return sayError("That number is not valid. Use the full international format, starting with plus.");
      return dialNumber(to, callerId, beginCall(req, url, p, "outbound", { orgId: agent?.orgId ?? null, businessNumber: callerId }));
    }

    // From a phone to one of our numbers: the assistant answers if it wants
    // to; otherwise ring the browsers of that number's organisation
    // (everyone, for the platform number).
    const orgId = orgForNumber(p.To ?? "");
    const ring = voiceDeps().users.available(orgId);
    const offer = offerCall({
      callSid: p.CallSid ?? "", orgId, from: p.From ?? "", to: p.To ?? "",
      callerName: voiceDeps().contactName?.(p.From ?? "") ?? (p.CallerName || null),
      agentsAvailable: ring.length,
    });
    if (offer) {
      console.log(`[voice] inbound ${p.From} → ${p.To} (${p.CallSid}) org ${orgId ?? "platform"}, assistant answering`);
      // The assistant's lines are the transcript, so it is always "transcribing".
      recordCall(p, "inbound", { orgId, businessNumber: p.To ?? "", transcribing: true });
      const base = publicUrl(req, url);
      const socket = new URL(RELAY_PATH, base);
      socket.protocol = socket.protocol === "http:" ? "ws:" : "wss:";
      return connectRelay(socket.href, new URL(RELAY_END_PATH, base).href, offer.token, offer.greeting);
    }
    console.log(`[voice] inbound ${p.From} → ${p.To} (${p.CallSid}) org ${orgId ?? "platform"}, ringing ${ring.length} agent(s)`);
    return dialClients(ring, 25, ring.length ? beginCall(req, url, p, "inbound", { orgId, businessNumber: p.To ?? "" }) : "");
  }

  // The assistant's session is over. Hang up if it said so; otherwise
  // (handoff, or the relay failed) ring people.
  if (path === RELAY_END_PATH && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    const outcome = parseOutcome(p.HandoffData);
    console.log(`[voice] relay ended ${p.CallSid} (${p.SessionStatus ?? "?"}) → ${outcome?.action ?? "no outcome, ringing people"}`);
    if (outcome?.action === "hangup") return twiml(`${say("Thank you for calling. Goodbye.")}<Hangup/>`);
    const ring = voiceDeps().users.available(callOrgId(p.CallSid ?? ""));
    const before = ring.length ? say("One moment, I'm connecting you to a colleague.") + (transcriptionEnabled() ? transcriptionStart(req, url, "inbound") : "") : "";
    return dialClients(ring, 25, before);
  }

  if (path === "/webhooks/twilio/transcription" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    recordTranscriptionEvent(p);
    return new Response(null, { status: 204 });
  }

  // Operators see every call, admins their organisation's, agents their own.
  if (path === "/api/voice/calls" && method === "GET" && user) {
    return json(listCalls(user, url.searchParams.get("org")));
  }

  const transcriptMatch = path.match(/^\/api\/voice\/calls\/([^/]+)\/transcript$/);
  if (transcriptMatch && method === "GET" && user) {
    const sid = decodeURIComponent(transcriptMatch[1]!);
    if (!(await canSeeCall(user, sid))) return json({ error: "Call not found" }, 404);
    return json(await buildCallTranscript(sid));
  }

  // --- An organisation's phone numbers ------------------------------------
  // The Account SID is what the number's owner gives Twilio for the transfer.
  if (path === "/api/voice/numbers" && method === "GET" && user) {
    const orgId = url.searchParams.get("org") ?? "";
    if (!managesOrg(user, orgId)) return forbidden();
    return json({ accountSid: voiceConfig().accountSid, numbers: listNumbers(orgId) });
  }

  if (path === "/api/voice/numbers" && method === "POST" && user) {
    const b = await req.json().catch(() => null) as { orgId?: string; phoneNumber?: string } | null;
    if (!b?.orgId || !b.phoneNumber) return json({ error: "orgId and phoneNumber are required" }, 400);
    if (!managesOrg(user, b.orgId)) return forbidden();
    const res = await addNumber(b.orgId, b.phoneNumber);
    return res.ok ? json(res.number, 201) : json({ error: res.error }, 400);
  }

  if (path === "/api/voice/numbers/check" && method === "POST" && user) {
    const orgId = url.searchParams.get("org") ?? "";
    if (!managesOrg(user, orgId)) return forbidden();
    await checkPendingNumbers(orgId);
    return json({ numbers: listNumbers(orgId) });
  }

  const numberMatch = path.match(/^\/api\/voice\/numbers\/([^/]+)$/);
  if (numberMatch && method === "DELETE" && user) {
    const orgId = url.searchParams.get("org") ?? "";
    if (!managesOrg(user, orgId)) return forbidden();
    const removed = removeNumber(orgId, decodeURIComponent(numberMatch[1]!));
    return removed ? json({ ok: true }) : json({ error: "Number not found" }, 404);
  }

  if ((path === "/webhooks/twilio/status" || path === "/webhooks/twilio/recording") && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    console.log(`[voice] ${path.split("/").pop()} ${p.CallSid} ${p.CallStatus ?? p.RecordingStatus ?? ""}`);
    return twiml("");
  }

  return null;
}

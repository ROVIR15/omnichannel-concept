// Voice endpoints: a token for the browser, the webhooks Twilio calls, and
// each organisation's phone numbers. Every incoming call goes through
// routeCall(): assistant → free agents → line → voicemail, each step skipped
// when its add-on is off. The platform number (Settings) is its own line and
// rings everyone available.

import { voiceDeps, type VoiceUser } from "./context";
import { addNumber, callerIdFor, checkPendingNumbers, listNumbers, orgForNumber, removeNumber } from "./numbers";
import {
  dispatch, finish, freeAgents, hasWaiting, join, listQueue, noteQueueSid, position, queueName, queueSettings, ringedOut,
  setPublicBase, timedOut, waitOf,
} from "./queue";
import { offerCall, parseOutcome, RELAY_END_PATH, RELAY_PATH } from "./relay";
import {
  buildCallTranscript, callOrgId, canSeeCall, listCalls, recordCall, recordTranscriptionEvent, recordVoicemail, trackLabels,
  type Direction,
} from "./transcripts";
import {
  connectRelay, dialClients, dialNumber, enqueue, missingForCalls, offerToAgent, say, sayError, startTranscription,
  stopTranscription, transcriptionEnabled, twiml, validTwilioSignature, voiceConfig, voicemail, voiceToken, waitMessage,
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
  if (!validTwilioSignature(publicUrl(req, url), params, req.headers.get("x-twilio-signature"))) return null;
  setPublicBase(new URL(publicUrl(req, url)).origin);
  return params;
}

const hookUrl = (req: Request, url: URL, path: string) => new URL(path, publicUrl(req, url)).href;

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

function transcriptionStart(req: Request, url: URL, direction: Direction, name = "live"): string {
  return startTranscription(hookUrl(req, url, "/webhooks/twilio/transcription"), trackLabels(direction), name);
}

const DIAL_ANSWERED = new Set(["completed", "answered"]);

/** Every incoming call takes this path:
 *    1. the assistant answers, if it wants to (relay.ts)
 *    2. else free agents ring
 *    3. else the caller waits in line (queue.ts)
 *    4. else voicemail */
async function routeCall(req: Request, url: URL, p: Record<string, string>): Promise<Response> {
  const orgId = orgForNumber(p.To ?? "");
  const callSid = p.CallSid ?? "";
  const free = await freeAgents(orgId);
  const where = `${p.From} → ${p.To} (${callSid}) org ${orgId ?? "platform"}`;

  const offer = offerCall({
    callSid, orgId, from: p.From ?? "", to: p.To ?? "",
    callerName: voiceDeps().contactName?.(p.From ?? "") ?? (p.CallerName || null),
    agentsAvailable: free.length,
  });
  if (offer) {
    console.log(`[voice] inbound ${where}, assistant answering`);
    // The assistant's lines are the transcript, so it is always "transcribing".
    recordCall(p, "inbound", { orgId, businessNumber: p.To ?? "", transcribing: true });
    const socket = new URL(RELAY_PATH, publicUrl(req, url));
    socket.protocol = socket.protocol === "http:" ? "ws:" : "wss:";
    return connectRelay(socket.href, hookUrl(req, url, RELAY_END_PATH), offer.token, offer.greeting);
  }

  console.log(`[voice] inbound ${where}, ${free.length} free agent(s)`);
  recordCall(p, "inbound", { orgId, businessNumber: p.To ?? "", transcribing: transcriptionEnabled() });
  return toPeople(req, url, callSid, orgId, { free });
}

/** Steps 2–4. Also where the assistant hands a call over. */
async function toPeople(
  req: Request, url: URL, callSid: string, orgId: string | null, opts: { free?: string[]; intro?: string } = {},
): Promise<Response> {
  const free = opts.free ?? await freeAgents(orgId);
  const intro = opts.intro ?? "";
  // Nobody jumps the line: with callers waiting, a new one joins behind them.
  if (free.length && !hasWaiting(orgId)) {
    const transcribe = transcriptionEnabled() ? transcriptionStart(req, url, "inbound") : "";
    return dialClients(free, 25, intro + transcribe, hookUrl(req, url, "/webhooks/twilio/rang"));
  }
  return lineOrVoicemail(req, url, callSid, orgId, intro);
}

function lineOrVoicemail(req: Request, url: URL, callSid: string, orgId: string | null, before = ""): Response {
  if (queueSettings(orgId) && join(callSid, orgId)) {
    return enqueue(queueName(orgId), hookUrl(req, url, "/webhooks/twilio/queue/wait"), hookUrl(req, url, "/webhooks/twilio/queue/left"), before);
  }
  return voicemail(hookUrl(req, url, "/webhooks/twilio/voicemail"), before);
}

/** Ring the agent dispatch() picked for this caller. */
function offerTwiml(req: Request, url: URL, callSid: string): Response {
  const row = waitOf(callSid);
  if (!row || row.state !== "ringing" || !row.agent_user_id) return lineOrVoicemail(req, url, callSid, row?.org_id ?? callOrgId(callSid));
  const agent = encodeURIComponent(row.agent_user_id);
  // A fresh transcription per attempt, so hold music between attempts isn't transcribed.
  const transcribe = transcriptionEnabled() ? transcriptionStart(req, url, "inbound", `q${row.attempts}`) : "";
  return offerToAgent(
    row.agent_user_id,
    hookUrl(req, url, `/webhooks/twilio/queue/offer-end?agent=${agent}`),
    hookUrl(req, url, `/webhooks/twilio/queue/answered?call=${encodeURIComponent(callSid)}`),
    transcribe,
  );
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

    // From a phone to one of our numbers.
    return routeCall(req, url, p);
  }

  // Free agents rang and no one answered: the line, or voicemail.
  if (path === "/webhooks/twilio/rang" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    if (DIAL_ANSWERED.has(p.DialCallStatus ?? "")) return twiml("<Hangup/>");
    const stop = transcriptionEnabled() ? stopTranscription("live") : "";
    return lineOrVoicemail(req, url, p.CallSid ?? "", callOrgId(p.CallSid ?? ""), stop);
  }

  // --- The line (queue.ts) ------------------------------------------------
  // Twilio asks what a waiting caller hears, over and over.
  if (path === "/webhooks/twilio/queue/wait" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    const callSid = p.CallSid ?? "";
    if (p.QueueSid) noteQueueSid(callSid, p.QueueSid);
    void dispatch(waitOf(callSid)?.org_id ?? callOrgId(callSid));
    return waitMessage(position(callSid));
  }

  // The caller left the Twilio queue.
  if (path === "/webhooks/twilio/queue/left" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    const callSid = p.CallSid ?? "";
    switch (p.QueueResult) {
      case "hangup":
        finish(callSid, "abandoned");
        return twiml("");
      case "bridged":
        finish(callSid, "answered");
        return twiml("<Hangup/>");
      case "redirected": {
        // We took them out (dispatch); same TwiML as where we sent them.
        const row = waitOf(callSid);
        return row?.state === "ringing" ? offerTwiml(req, url, callSid) : voicemail(hookUrl(req, url, "/webhooks/twilio/voicemail"));
      }
      default: // leave, queue-full, error: don't lose the caller
        finish(callSid, p.QueueResult === "queue-full" ? "full" : "timeout");
        return voicemail(hookUrl(req, url, "/webhooks/twilio/voicemail"));
    }
  }

  // dispatch() sent the caller here to ring one agent.
  if (path === "/webhooks/twilio/queue/offer" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    return offerTwiml(req, url, p.CallSid ?? "");
  }

  // The agent picked up (status callback on their leg; `call` = the caller).
  if (path === "/webhooks/twilio/queue/answered" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    finish(url.searchParams.get("call") ?? "", "answered");
    return new Response(null, { status: 204 });
  }

  // The ring to one agent ended. Not answered: back in line, or voicemail.
  if (path === "/webhooks/twilio/queue/offer-end" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    const callSid = p.CallSid ?? "";
    const row = waitOf(callSid);
    if (DIAL_ANSWERED.has(p.DialCallStatus ?? "")) {
      finish(callSid, "answered");
      return twiml("<Hangup/>");
    }
    if (!row) return voicemail(hookUrl(req, url, "/webhooks/twilio/voicemail"));
    ringedOut(callSid);
    const stop = transcriptionEnabled() ? stopTranscription(`q${row.attempts}`) : "";
    if (timedOut(row)) {
      finish(callSid, "timeout");
      return voicemail(hookUrl(req, url, "/webhooks/twilio/voicemail"), stop);
    }
    return lineOrVoicemail(req, url, callSid, row.org_id, stop);
  }

  // dispatch() found the caller waited too long.
  if (path === "/webhooks/twilio/queue/timeout" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    return voicemail(hookUrl(req, url, "/webhooks/twilio/voicemail"));
  }

  if (path === "/webhooks/twilio/voicemail" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    if (p.RecordingUrl) recordVoicemail(p.CallSid ?? "", p.RecordingUrl, Number(p.RecordingDuration) || 0);
    return twiml(`${say("Thank you. We'll get back to you soon. Goodbye.")}<Hangup/>`);
  }

  // The assistant's session is over. Hang up if it said so; otherwise
  // (handoff, or the relay failed) ring people.
  if (path === RELAY_END_PATH && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    const outcome = parseOutcome(p.HandoffData);
    console.log(`[voice] relay ended ${p.CallSid} (${p.SessionStatus ?? "?"}) → ${outcome?.action ?? "no outcome, ringing people"}`);
    if (outcome?.action === "hangup") return twiml(`${say("Thank you for calling. Goodbye.")}<Hangup/>`);
    return toPeople(req, url, p.CallSid ?? "", callOrgId(p.CallSid ?? ""), { intro: say("One moment, I'm connecting you to a colleague.") });
  }

  if (path === "/webhooks/twilio/transcription" && method === "POST") {
    const p = await twilioParams(req, url);
    if (!p) return new Response("invalid signature", { status: 403 });
    recordTranscriptionEvent(p);
    return new Response(null, { status: 204 });
  }

  // Who is waiting. Operators see every line (or one, with ?org=); everyone
  // else sees their organisation's.
  if (path === "/api/voice/queue" && method === "GET" && user) {
    const orgId = user.role === "operator" ? (url.searchParams.get("org") ?? undefined) : user.orgId;
    return json(listQueue(orgId));
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
    // A caller who hangs up while in line (or being rung) is a missed call.
    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(p.CallStatus ?? "")) finish(p.CallSid ?? "", "abandoned");
    return twiml("");
  }

  return null;
}

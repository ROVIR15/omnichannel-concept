// Call transcripts. The voice webhook records each call; with the
// twilio_transcription flag on, Twilio posts every finished sentence to
// /webhooks/twilio/transcription. buildCallTranscript() turns that into one
// JSON document per call. Format and flow: docs/call-channel/call-transcripts.md

import { db, voiceDeps, type VoiceUser } from "./context";
import { twilioGet } from "./twilio";

export type Direction = "inbound" | "outbound";
export type Speaker = "customer" | "agent" | "assistant";
type TranscriptStatus = "disabled" | "in-progress" | "completed" | "failed";

/** Twilio's tracks are relative to the leg running our TwiML: the customer on
 *  an inbound call, the agent's browser on an outbound one. */
export function trackLabels(direction: Direction): { inbound: Speaker; outbound: Speaker } {
  return direction === "inbound" ? { inbound: "customer", outbound: "agent" } : { inbound: "agent", outbound: "customer" };
}

/** The assistant's lines are stored under their own track (relay.ts). */
export const ASSISTANT_TRACK = "assistant";

const speakerFor = (direction: Direction, track: string): Speaker =>
  track === ASSISTANT_TRACK ? "assistant"
    : track === "outbound_track" ? trackLabels(direction).outbound : trackLabels(direction).inbound;

interface CallRow {
  call_sid: string;
  direction: Direction;
  customer_number: string;
  business_number: string;
  customer_location: string;
  caller_name: string | null;
  agent_user_id: string | null;
  org_id: string | null;
  transcript_status: TranscriptStatus;
  transcript_error: string | null;
  language: string | null;
  engine: string | null;
  details: string | null;
  assistant_handoff: string | null;
  created_at: number;
}

/** What we keep from Twilio's call record once the call has ended. */
interface CallDetails {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  price: { amount: number; currency: string } | null;
  answeredBy: string | null;
}

const FINAL_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

const getCall = (sid: string) =>
  db().query<CallRow, [string]>("SELECT * FROM voice_calls WHERE call_sid = ?").get(sid);

/** Called from the voice webhook as the call starts. Twilio may retry the
 *  webhook, so a second insert for the same call is ignored. `businessNumber`
 *  is our side of the call; `orgId` is null for the platform number. */
export function recordCall(
  p: Record<string, string>, direction: Direction,
  { orgId, businessNumber, transcribing }: { orgId: string | null; businessNumber: string; transcribing: boolean },
) {
  const side = direction === "inbound" ? "From" : "To";
  const location = { city: p[`${side}City`] || null, state: p[`${side}State`] || null, country: p[`${side}Country`] || null };
  db().query(`
    INSERT OR IGNORE INTO voice_calls
      (call_sid, direction, customer_number, business_number, customer_location, caller_name, agent_user_id, org_id, transcript_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.CallSid ?? "",
    direction,
    (direction === "inbound" ? p.From : p.To) ?? "",
    businessNumber,
    JSON.stringify(location),
    p.CallerName || null,
    direction === "outbound" ? (p.From ?? "").replace(/^client:/, "") : null,
    orgId,
    transcribing ? "in-progress" : "disabled",
    Date.now(),
  );
}

/** One finished sentence from an assistant-answered call (relay.ts), stored
 *  like a Real-Time Transcription segment. */
export function recordAssistantSegment(callSid: string, speaker: "customer" | "assistant", sequence: number, text: string) {
  db().query(`
    INSERT OR IGNORE INTO voice_transcript_segments (call_sid, transcription_sid, track, sequence_id, text, confidence, at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(callSid, `relay-${callSid}`, speaker === "assistant" ? ASSISTANT_TRACK : "inbound_track", sequence, text, new Date().toISOString());
}

/** The assistant handed the call to people, with this summary for them. */
export function recordHandoff(callSid: string, summary: string) {
  db().query("UPDATE voice_calls SET assistant_handoff = ? WHERE call_sid = ?").run(summary, callSid);
}

export const callOrgId = (callSid: string): string | null => getCall(callSid)?.org_id ?? null;

/** One Real-Time Transcription webhook. Only final sentences are stored. */
export function recordTranscriptionEvent(p: Record<string, string>) {
  const sid = p.CallSid ?? "";
  if (!getCall(sid)) {
    console.warn(`[voice] transcription event for unknown call ${sid}`);
    return;
  }
  switch (p.TranscriptionEvent) {
    case "transcription-started":
      db().query("UPDATE voice_calls SET language = ?, engine = ? WHERE call_sid = ?")
        .run(p.LanguageCode || null, p.TranscriptionEngine || null, sid);
      break;
    case "transcription-content": {
      if (p.Final !== "true") break;
      const data = JSON.parse(p.TranscriptionData || "{}") as { transcript?: string; confidence?: number };
      if (!data.transcript?.trim()) break;
      db().query(`
        INSERT OR IGNORE INTO voice_transcript_segments (call_sid, transcription_sid, track, sequence_id, text, confidence, at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sid, p.TranscriptionSid ?? "", p.Track ?? "", Number(p.SequenceId) || 0,
        data.transcript.trim(), data.confidence ?? null, p.Timestamp || new Date().toISOString());
      break;
    }
    case "transcription-stopped":
      db().query("UPDATE voice_calls SET transcript_status = 'completed' WHERE call_sid = ? AND transcript_status = 'in-progress'").run(sid);
      break;
    case "transcription-error": {
      const error = [p.TranscriptionErrorCode, p.TranscriptionError].filter(Boolean).join(" ") || "unknown error";
      console.warn(`[voice] transcription error on ${sid}: ${error}`);
      db().query("UPDATE voice_calls SET transcript_status = 'failed', transcript_error = ? WHERE call_sid = ?").run(error, sid);
      break;
    }
  }
}

const isoOrNull = (twilioDate: string | null | undefined) => (twilioDate ? new Date(twilioDate).toISOString() : null);

/** Twilio's record of the call: from the cache once the call has ended,
 *  otherwise fetched live. Null when Twilio can't be reached. */
async function callDetails(row: CallRow): Promise<CallDetails | null> {
  if (row.details) return JSON.parse(row.details) as CallDetails;

  type TwilioCall = { status: string; start_time: string | null; end_time: string | null; duration: string | null; price: string | null; price_unit: string; to: string };
  const call = await twilioGet<TwilioCall>(`/Calls/${encodeURIComponent(row.call_sid)}.json`);
  if (!call) return null;

  // Inbound calls ring several browsers; the child leg that completed is the one that answered.
  let answeredBy: string | null = null;
  if (row.direction === "inbound") {
    const children = await twilioGet<{ calls: TwilioCall[] }>(`/Calls.json?ParentCallSid=${encodeURIComponent(row.call_sid)}`);
    const answered = children?.calls.find((c) => c.to.startsWith("client:") && c.status === "completed");
    answeredBy = answered ? answered.to.replace(/^client:/, "") : null;
  }

  const details: CallDetails = {
    status: call.status,
    startedAt: isoOrNull(call.start_time),
    endedAt: isoOrNull(call.end_time),
    durationSec: call.duration == null ? null : Number(call.duration),
    price: call.price == null ? null : { amount: Number(call.price), currency: call.price_unit },
    answeredBy,
  };
  // Price shows up a little after the call ends; keep asking until it does.
  if (FINAL_CALL_STATUSES.has(call.status) && details.price) {
    db().query("UPDATE voice_calls SET details = ? WHERE call_sid = ?").run(JSON.stringify(details), row.call_sid);
  }
  return details;
}

function customerName(row: CallRow): { name: string | null; nameSource: "contacts" | "twilio" | null } {
  const contact = voiceDeps().contactName?.(row.customer_number);
  if (contact) return { name: contact, nameSource: "contacts" };
  if (row.caller_name) return { name: row.caller_name, nameSource: "twilio" };
  return { name: null, nameSource: null };
}

/** Access check for one call, without building the whole document. */
export async function canSeeCall(user: VoiceUser, callSid: string): Promise<boolean> {
  const row = getCall(callSid);
  if (!row) return false;
  return visibleTo(user, row, user.role === "agent" ? await callDetails(row) : null);
}

const agentOf = (row: CallRow, details: CallDetails | null) => row.agent_user_id ?? details?.answeredBy ?? null;

/** Who sees a call: operators every call, admins their organisation's calls,
 *  agents the calls they took. An inbound call's agent is only known from the
 *  cached details, shortly after it ends. */
function visibleTo(user: VoiceUser, row: CallRow, details: CallDetails | null): boolean {
  if (user.role === "operator") return true;
  if (user.role === "admin") return row.org_id === user.orgId;
  return agentOf(row, details) === user.id;
}

/** Recent calls for the inbox list, newest first. Database only — no Twilio
 *  requests — so the inbox can poll it. `orgId` narrows an operator's list to
 *  that organisation plus calls on the platform number. */
export function listCalls(user: VoiceUser, orgId: string | null, limit = 50) {
  const rows = db().query<CallRow & { segments: number; last_text: string | null }, []>(`
    SELECT c.*,
      (SELECT COUNT(*) FROM voice_transcript_segments s WHERE s.call_sid = c.call_sid) AS segments,
      (SELECT text FROM voice_transcript_segments s WHERE s.call_sid = c.call_sid
        ORDER BY at DESC, sequence_id DESC LIMIT 1) AS last_text
    FROM voice_calls c ORDER BY c.created_at DESC`,
  ).all();

  return rows
    .map((row) => ({ row, details: row.details ? (JSON.parse(row.details) as CallDetails) : null }))
    .filter(({ row, details }) => visibleTo(user, row, details) && (!orgId || row.org_id === orgId || row.org_id === null))
    .slice(0, limit)
    .map(({ row, details }) => ({
      sid: row.call_sid,
      direction: row.direction,
      customer: { number: row.customer_number, ...customerName(row) },
      status: details?.status ?? null,
      durationSec: details?.durationSec ?? null,
      transcriptStatus: row.transcript_status === "in-progress" && details ? "completed" : row.transcript_status,
      segments: row.segments,
      preview: row.last_text ?? "",
      createdAt: row.created_at,
    }));
}

/** The transcript document for one call (version 1), or null for an unknown call. */
export async function buildCallTranscript(callSid: string) {
  const row = getCall(callSid);
  if (!row) return null;

  const details = await callDetails(row);
  const agentId = row.agent_user_id ?? details?.answeredBy ?? null;
  const agent = agentId ? voiceDeps().users.get(agentId) : null;
  const callEnded = details ? FINAL_CALL_STATUSES.has(details.status) : false;

  const segments = db().query<{ track: string; text: string; confidence: number | null; at: string }, [string]>(
    "SELECT track, text, confidence, at FROM voice_transcript_segments WHERE call_sid = ? ORDER BY at, sequence_id",
  ).all(callSid).map((s, i) => ({
    seq: i + 1,
    speaker: speakerFor(row.direction, s.track),
    text: s.text,
    startedAt: new Date(s.at).toISOString(),
    confidence: s.confidence,
  }));

  // transcription-stopped can be lost; a call that has ended is done either way.
  const status: TranscriptStatus = row.transcript_status === "in-progress" && callEnded ? "completed" : row.transcript_status;

  return {
    version: 1,
    call: {
      sid: row.call_sid,
      direction: row.direction,
      status: details?.status ?? "unknown",
      startedAt: details?.startedAt ?? new Date(row.created_at).toISOString(),
      endedAt: details?.endedAt ?? null,
      durationSec: callEnded ? details?.durationSec ?? null : null,
      price: details?.price ?? null,
    },
    participants: {
      customer: {
        number: row.customer_number,
        ...customerName(row),
        location: JSON.parse(row.customer_location),
      },
      agent: agentId ? { userId: agentId, name: agent?.name ?? null } : null,
      businessNumber: row.business_number,
    },
    /** Set when an assistant answered first and handed the call to people. */
    handoff: row.assistant_handoff ? { summary: row.assistant_handoff } : null,
    transcript: {
      status,
      language: row.language,
      engine: row.engine,
      error: row.transcript_error,
      segments,
      text: segments.map((s) => `${s.speaker}: ${s.text}`).join("\n"),
    },
  };
}

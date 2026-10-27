// An assistant answering calls, through Twilio ConversationRelay. Twilio does
// speech-to-text and text-to-speech; we only trade text over a WebSocket:
//
//   1. The voice webhook asks the assistant whether it answers this call. If
//      so it returns <Connect><ConversationRelay>, with a one-time token.
//   2. Twilio opens /webhooks/twilio/relay and sends "setup" with the token.
//   3. Each "prompt" (a finished caller sentence) goes to assistant.reply();
//      the reply streams back as "text" pieces, spoken as they arrive.
//   4. A handoff or hangup sends "end"; Twilio then posts to
//      /webhooks/twilio/relay-end, which rings people or hangs up.
//
// Message format: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { voiceDeps, type VoiceAssistantCall, type VoiceAssistantCallInfo } from "./context";
import { recordAssistantSegment, recordHandoff } from "./transcripts";

export const RELAY_PATH = "/webhooks/twilio/relay";
export const RELAY_END_PATH = "/webhooks/twilio/relay-end";

/** What the relay-end webhook gets back from us, through Twilio. */
export type RelayOutcome = { action: "handoff"; summary: string } | { action: "hangup" };

interface Pending {
  info: VoiceAssistantCallInfo;
  call: VoiceAssistantCall;
  expires: number;
}

/** Calls we said yes to whose socket hasn't sent "setup" yet, by token. */
const pending = new Map<string, Pending>();
const PENDING_MS = 60_000;

interface Live extends Pending {
  sequence: number;
  /** The reply being spoken now; aborted when the caller talks over it. */
  turn: AbortController | null;
  /** Set by an "interrupt": what the caller actually heard of that reply. */
  heard: string | null;
  ended: boolean;
}

export interface RelaySocketData {
  live: Live | null;
}

type Incoming =
  | { type: "setup"; callSid: string; customParameters?: Record<string, string> }
  | { type: "prompt"; voicePrompt: string; last?: boolean }
  | { type: "interrupt"; utteranceUntilInterrupt: string }
  | { type: "error"; description: string }
  | { type: string };

/** Ask the assistant to take this call. Null = ring people as usual. */
export function offerCall(info: VoiceAssistantCallInfo): { token: string; greeting: string } | null {
  const assistant = voiceDeps().assistant;
  if (!assistant) return null;
  let call: VoiceAssistantCall | null;
  try {
    call = assistant.answer(info);
  } catch (err) {
    console.warn(`[voice] assistant failed to answer ${info.callSid}, ringing people: ${err}`);
    return null;
  }
  if (!call) return null;

  const now = Date.now();
  for (const [t, p] of pending) if (p.expires < now) pending.delete(t);
  const token = crypto.randomUUID();
  pending.set(token, { info, call, expires: now + PENDING_MS });
  return { token, greeting: call.greeting };
}

/** Upgrades Twilio's relay socket. True when the request was taken. */
export function upgradeRelay(req: Request, url: URL, server: Server<RelaySocketData>): boolean {
  if (url.pathname !== RELAY_PATH) return false;
  return server.upgrade(req, { data: { live: null } });
}

const send = (ws: ServerWebSocket<RelaySocketData>, msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));

/** Twilio sends no "finished speaking" event, so before ending we wait about
 *  as long as the last reply takes to say, or the caller never hears it. */
const speakingMs = (text: string) => Math.min(8000, text.split(/\s+/).filter(Boolean).length * 400);

async function endSession(ws: ServerWebSocket<RelaySocketData>, live: Live, outcome: RelayOutcome, lastSaid: string) {
  if (live.ended) return;
  live.ended = true;
  if (outcome.action === "handoff") recordHandoff(live.info.callSid, outcome.summary);
  console.log(`[voice] assistant ${outcome.action} on ${live.info.callSid}`);
  await Bun.sleep(speakingMs(lastSaid));
  send(ws, { type: "end", handoffData: JSON.stringify(outcome) });
  live.call.ended?.();
}

async function runTurn(ws: ServerWebSocket<RelaySocketData>, live: Live, callerText: string) {
  live.turn?.abort();
  const turn = new AbortController();
  live.turn = turn;
  live.heard = null;
  recordAssistantSegment(live.info.callSid, "customer", ++live.sequence, callerText);

  let said = "";
  let outcome: RelayOutcome | null = null;
  try {
    for await (const action of live.call.reply(callerText, turn.signal)) {
      if (turn.signal.aborted) break;
      if ("say" in action) {
        said += action.say;
        send(ws, { type: "text", token: action.say, last: false });
      } else {
        outcome = "handoff" in action ? { action: "handoff", summary: action.handoff } : { action: "hangup" };
        break;
      }
    }
    if (!turn.signal.aborted) send(ws, { type: "text", token: "", last: true });
  } catch (err) {
    if (!turn.signal.aborted) {
      // The assistant broke (provider down, bad key…): people take over.
      console.warn(`[voice] assistant error on ${live.info.callSid}: ${err}`);
      outcome = { action: "handoff", summary: "The assistant had a technical problem mid-call." };
    }
  } finally {
    const spoken = (turn.signal.aborted ? live.heard ?? said : said).trim();
    if (spoken) recordAssistantSegment(live.info.callSid, "assistant", ++live.sequence, spoken);
    if (live.turn === turn) live.turn = null;
  }
  if (outcome) await endSession(ws, live, outcome, said);
}

export const relayWebsocket: WebSocketHandler<RelaySocketData> = {
  message(ws, raw) {
    let msg: Incoming;
    try {
      msg = JSON.parse(String(raw)) as Incoming;
    } catch {
      return;
    }
    const live = ws.data.live;

    if (msg.type === "setup") {
      const m = msg as Extract<Incoming, { type: "setup" }>;
      const token = m.customParameters?.token ?? "";
      const found = pending.get(token);
      pending.delete(token);
      if (!found || found.info.callSid !== m.callSid || found.expires < Date.now()) {
        console.warn(`[voice] relay setup refused for ${m.callSid}`);
        ws.close(1008, "unknown call");
        return;
      }
      ws.data.live = { ...found, sequence: 0, turn: null, heard: null, ended: false };
      // The greeting was spoken by Twilio; keep it in the transcript too.
      recordAssistantSegment(m.callSid, "assistant", ++ws.data.live.sequence, found.call.greeting);
      return;
    }
    if (!live || live.ended) return;

    switch (msg.type) {
      case "prompt": {
        const m = msg as Extract<Incoming, { type: "prompt" }>;
        if (m.last === false || !m.voicePrompt.trim()) return;
        runTurn(ws, live, m.voicePrompt.trim()).catch((e) => console.warn(`[voice] relay turn: ${e}`));
        return;
      }
      case "interrupt": {
        const heard = (msg as Extract<Incoming, { type: "interrupt" }>).utteranceUntilInterrupt ?? "";
        live.heard = heard;
        live.turn?.abort();
        live.call.interrupted?.(heard);
        return;
      }
      case "error":
        console.warn(`[voice] relay error on ${live.info.callSid}: ${(msg as Extract<Incoming, { type: "error" }>).description}`);
        return;
    }
  },

  close(ws) {
    const live = ws.data.live;
    if (!live) return;
    live.turn?.abort();
    if (!live.ended) {
      live.ended = true;
      live.call.ended?.();
    }
  },
};

/** Reads the outcome Twilio echoes back on relay-end. Null when the session
 *  ended without one (caller hung up, or the socket failed). */
export function parseOutcome(handoffData: string | undefined): RelayOutcome | null {
  try {
    const o = JSON.parse(handoffData ?? "") as RelayOutcome;
    return o.action === "handoff" || o.action === "hangup" ? o : null;
  } catch {
    return null;
  }
}

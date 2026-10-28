// The waiting line. When everyone is busy, a caller joins their
// organisation's line; Twilio holds the call and plays music, and this file
// decides who goes next:
//
//   1. join()      the caller gets a row here and is put in a Twilio queue.
//   2. dispatch()  for each free agent, the longest-waiting caller is taken
//                  out of the Twilio queue and rung through to that agent.
//   3. The agent answers → done. No answer → back in line at the same place
//      (the order is ours, by joined_at, not Twilio's).
//   4. Waited too long → voicemail. Hung up → abandoned (a missed call).
//
// dispatch() runs when someone joins, when a ring ends, and every few seconds
// (an agent may become free at any moment: a call ends, a status changes).

import { db, voiceDeps, type VoiceQueueSettings } from "./context";
import { twilioGet, twilioPost } from "./twilio";

export type WaitState = "waiting" | "ringing" | "done";
export type WaitOutcome = "answered" | "abandoned" | "timeout" | "full";

interface WaitRow {
  call_sid: string;
  org_id: string | null;
  queue_sid: string | null;
  state: WaitState;
  agent_user_id: string | null;
  attempts: number;
  outcome: WaitOutcome | null;
  joined_at: number;
  offered_at: number | null;
  left_at: number | null;
}

const DEFAULTS: Required<VoiceQueueSettings> = { maxWaitSec: 300, maxSize: 10 };
const SWEEP_EVERY_MS = 5_000;
/** An agent who let a caller ring out isn't offered another for this long. */
const NO_ANSWER_PAUSE_MS = 30_000;

/** The organisation's line settings; null = it has no line. */
export function queueSettings(orgId: string | null): Required<VoiceQueueSettings> | null {
  const s = voiceDeps().queue?.(orgId);
  if (!s) return null;
  return { maxWaitSec: s.maxWaitSec ?? DEFAULTS.maxWaitSec, maxSize: s.maxSize ?? DEFAULTS.maxSize };
}

/** Twilio queue name. Twilio creates the queue on first use. */
export const queueName = (orgId: string | null) => (orgId ? `org-${orgId}` : "platform");

/** Webhooks Twilio calls back on need a public URL; we learn ours from
 *  Twilio's own requests (routes.ts), since dispatch() runs on a timer. */
let publicBase: string | null = null;
export const setPublicBase = (origin: string) => { publicBase = origin; };
const hook = (path: string) => (publicBase ? new URL(path, publicBase).href : null);

const getWait = (callSid: string) =>
  db().query<WaitRow, [string]>("SELECT * FROM voice_queue_waits WHERE call_sid = ?").get(callSid);

/** Line order: who joined first. rowid breaks ties within a millisecond. */
const LINE_ORDER = "ORDER BY joined_at, rowid";

const openWaits = (orgId: string | null) =>
  db().query<WaitRow, [string | null]>(
    `SELECT * FROM voice_queue_waits WHERE state != 'done' AND org_id IS ? ${LINE_ORDER}`,
  ).all(orgId);

export const hasWaiting = (orgId: string | null) => openWaits(orgId).length > 0;

const noAnswerUntil = new Map<string, number>();

/** Agents on a call or being rung right now, from Twilio itself: any live
 *  call leg to or from a browser. No state of ours to drift. */
async function busyAgents(): Promise<Set<string>> {
  type Calls = { calls: { from: string; to: string }[] };
  const pages = await Promise.all([
    twilioGet<Calls>("/Calls.json?Status=in-progress&PageSize=1000"),
    twilioGet<Calls>("/Calls.json?Status=ringing&PageSize=1000"),
  ]);
  const busy = new Set<string>();
  for (const call of pages.flatMap((p) => p?.calls ?? [])) {
    for (const side of [call.from, call.to]) if (side?.startsWith("client:")) busy.add(side.slice("client:".length));
  }
  return busy;
}

/** Who can take a call now: available (says the host), not on a call, not
 *  being offered one, and didn't just let one ring out. */
export async function freeAgents(orgId: string | null): Promise<string[]> {
  const available = voiceDeps().users.available(orgId);
  if (!available.length) return [];
  const busy = await busyAgents();
  const offered = new Set(
    db().query<{ agent_user_id: string }, []>("SELECT agent_user_id FROM voice_queue_waits WHERE state = 'ringing'")
      .all().map((r) => r.agent_user_id),
  );
  const now = Date.now();
  return available.filter((id) => !busy.has(id) && !offered.has(id) && (noAnswerUntil.get(id) ?? 0) < now);
}

/** Puts the caller in line, or back in line at their old place. False when
 *  the line is full (recorded as such). */
export function join(callSid: string, orgId: string | null): boolean {
  const settings = queueSettings(orgId);
  const existing = getWait(callSid);
  if (existing && existing.state !== "done") {
    db().query("UPDATE voice_queue_waits SET state = 'waiting', agent_user_id = NULL WHERE call_sid = ?").run(callSid);
    return true;
  }
  const full = !settings || openWaits(orgId).length >= settings.maxSize;
  const now = Date.now();
  db().query(`
    INSERT OR REPLACE INTO voice_queue_waits (call_sid, org_id, state, outcome, joined_at, left_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(callSid, orgId, full ? "done" : "waiting", full ? "full" : null, now, full ? now : null);
  if (!full) console.log(`[voice] ${callSid} joined line ${queueName(orgId)}`);
  return !full;
}

/** 1 = next. Callers being rung still count: they may come back. */
export function position(callSid: string): number {
  const row = getWait(callSid);
  if (!row) return 1;
  return openWaits(row.org_id).findIndex((w) => w.call_sid === callSid) + 1 || 1;
}

/** Twilio's id for the queue holding this caller, from its wait request. */
export function noteQueueSid(callSid: string, queueSid: string) {
  db().query("UPDATE voice_queue_waits SET queue_sid = ? WHERE call_sid = ? AND queue_sid IS NOT ?").run(queueSid, callSid, queueSid);
}

export function finish(callSid: string, outcome: WaitOutcome, at = Date.now()) {
  const done = db().query(
    "UPDATE voice_queue_waits SET state = 'done', outcome = ?, left_at = ? WHERE call_sid = ? AND state != 'done'",
  ).run(outcome, at, callSid).changes > 0;
  if (done) console.log(`[voice] ${callSid} left the line: ${outcome}`);
}

export const waitOf = (callSid: string) => getWait(callSid);

export const timedOut = (row: WaitRow) => {
  const settings = queueSettings(row.org_id);
  return !settings || Date.now() - row.joined_at > settings.maxWaitSec * 1000;
};

/** The agent let the caller ring out: back in line, and that agent rests. */
export function ringedOut(callSid: string) {
  const row = getWait(callSid);
  if (row?.agent_user_id) noAnswerUntil.set(row.agent_user_id, Date.now() + NO_ANSWER_PAUSE_MS);
}

/** Take a caller out of the Twilio queue and send them to `path`. */
async function redirect(row: WaitRow, path: string): Promise<boolean> {
  const url = hook(path);
  if (!url || !row.queue_sid) return false;
  const res = await twilioPost(`/Queues/${row.queue_sid}/Members/${row.call_sid}.json`, { Url: url, Method: "POST" });
  return res !== null;
}

async function dispatchNow(orgId: string | null) {
  // Waited too long: out to voicemail.
  for (const row of openWaits(orgId)) {
    if (row.state === "waiting" && timedOut(row) && (await redirect(row, "/webhooks/twilio/queue/timeout"))) {
      finish(row.call_sid, "timeout");
    }
  }
  const waiting = openWaits(orgId).filter((w) => w.state === "waiting" && w.queue_sid);
  if (!waiting.length) return;
  const free = await freeAgents(orgId);

  for (let i = 0; i < Math.min(waiting.length, free.length); i++) {
    const row = waiting[i]!;
    const agent = free[i]!;
    db().query("UPDATE voice_queue_waits SET state = 'ringing', agent_user_id = ?, offered_at = ?, attempts = attempts + 1 WHERE call_sid = ?")
      .run(agent, Date.now(), row.call_sid);
    const ok = await redirect(row, `/webhooks/twilio/queue/offer?agent=${encodeURIComponent(agent)}`);
    if (!ok) {
      db().query("UPDATE voice_queue_waits SET state = 'waiting', agent_user_id = NULL WHERE call_sid = ? AND state = 'ringing'").run(row.call_sid);
      continue;
    }
    console.log(`[voice] offering ${row.call_sid} to ${agent}`);
  }
}

/** One run per line at a time; a call that comes in meanwhile runs once after. */
const running = new Map<string, Promise<void>>();

export function dispatch(orgId: string | null): Promise<void> {
  const key = queueName(orgId);
  const next = (running.get(key) ?? Promise.resolve())
    .then(() => dispatchNow(orgId))
    .catch((err) => console.warn(`[voice] dispatch ${key}: ${err}`));
  running.set(key, next);
  next.finally(() => { if (running.get(key) === next) running.delete(key); });
  return next;
}

/** A caller rung for over a minute whose call has ended hung up mid-ring
 *  (Twilio sends no dial result for a call that is gone). */
async function sweepStaleRings() {
  const stale = db().query<WaitRow, [number]>(
    "SELECT * FROM voice_queue_waits WHERE state = 'ringing' AND offered_at < ?",
  ).all(Date.now() - 60_000);
  for (const row of stale) {
    const call = await twilioGet<{ status: string }>(`/Calls/${encodeURIComponent(row.call_sid)}.json`);
    if (call && !["queued", "ringing", "in-progress"].includes(call.status)) finish(row.call_sid, "abandoned");
  }
}

/** Returns a function that stops the timer. */
export function startQueueSweeper(): () => void {
  const timer = setInterval(() => {
    const orgs = db().query<{ org_id: string | null }, []>(
      "SELECT DISTINCT org_id FROM voice_queue_waits WHERE state != 'done'",
    ).all();
    for (const { org_id } of orgs) void dispatch(org_id);
    if (orgs.length) sweepStaleRings().catch((e) => console.warn(`[voice] queue sweep: ${e}`));
  }, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Who is waiting, for the agents' screen. `orgId` undefined = every line. */
export function listQueue(orgId: string | null | undefined) {
  const rows = db().query<WaitRow & { customer_number: string; caller_name: string | null }, []>(`
    SELECT w.*, c.customer_number, c.caller_name FROM voice_queue_waits w
    JOIN voice_calls c ON c.call_sid = w.call_sid
    WHERE w.state != 'done' ORDER BY w.joined_at, w.rowid`,
  ).all().filter((r) => orgId === undefined || r.org_id === orgId);
  const now = Date.now();
  const seen = new Map<string | null, number>();
  return rows.map((r) => ({
    callSid: r.call_sid,
    orgId: r.org_id,
    customer: { number: r.customer_number, name: voiceDeps().contactName?.(r.customer_number) ?? r.caller_name },
    state: r.state,
    position: seen.set(r.org_id, (seen.get(r.org_id) ?? 0) + 1).get(r.org_id)!,
    waitingSec: Math.round((now - r.joined_at) / 1000),
    ringingAgent: r.state === "ringing" ? r.agent_user_id : null,
  }));
}

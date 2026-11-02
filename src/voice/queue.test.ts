// The waiting line, end to end, with a fake Twilio: webhooks are signed like
// Twilio signs them, and calls to Twilio's REST API are answered here.
// Run: bun test src/voice

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initVoice, type Voice } from ".";

const AUTH_TOKEN = "test-token";
const PLATFORM = "+15550000000";

// --- Fake Twilio REST API ---------------------------------------------------
let busy: string[] = []; // agents Twilio says are on a call
const redirects: { callSid: string; url: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.twilio.com/")) return realFetch(input, init);
  const path = url.replace(/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC1/, "");
  const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (path.startsWith("/Calls.json?Status=in-progress")) return ok({ calls: busy.map((a) => ({ from: "+1999", to: `client:${a}` })) });
  if (path.startsWith("/Calls.json?Status=ringing") || path.startsWith("/Calls.json?ParentCallSid")) return ok({ calls: [] });
  const member = path.match(/^\/Queues\/([^/]+)\/Members\/([^/]+)\.json$/);
  if (member && init?.method === "POST") {
    redirects.push({ callSid: member[2]!, url: new URLSearchParams(String(init.body)).get("Url")! });
    return ok({});
  }
  if (path.startsWith("/Calls/")) return ok({ status: "completed" });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// --- App under test -----------------------------------------------------------
let available = ["u1", "u2"];
let queue: { maxWaitSec?: number; maxSize?: number } | null = { maxSize: 3 };
let voice: Voice;
let server: ReturnType<typeof Bun.serve>;
let base = "";

function sign(url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return new Bun.CryptoHasher("sha1", AUTH_TOKEN).update(data).digest("base64");
}

/** POST a webhook as Twilio would. `path` may carry a query string. */
async function twilio(path: string, params: Record<string, string>) {
  const url = base + path;
  const res = await realFetch(url, {
    method: "POST",
    headers: { "x-twilio-signature": sign(url, params) },
    body: new URLSearchParams(params),
  });
  return res.text();
}

const pathOf = (url: string) => url.replace(base, "");
const call = (sid: string) => twilio("/webhooks/twilio/voice", { CallSid: sid, From: `+1${sid.slice(2).padStart(9, "0")}`, To: PLATFORM });
const waitIn = (sid: string) => twilio("/webhooks/twilio/queue/wait", { CallSid: sid, QueueSid: "QU1" });
const line = () => voice.queue.list(undefined).map((w) => `${w.position}:${w.callSid}:${w.state}`);

beforeAll(() => {
  const db = new Database(":memory:");
  voice = initVoice({
    db, watchNumbers: false,
    settings: () => ({
      accountSid: "AC1", authToken: AUTH_TOKEN, apiKeySid: "", apiKeySecret: "", twimlAppSid: "",
      phoneNumber: PLATFORM, transcription: false,
    }),
    users: { get: () => null, available: () => available },
    queue: () => queue,
  });
  server = Bun.serve({ port: 0, fetch: async (req) => (await voice.handle(req, new URL(req.url), null)) ?? new Response("nf", { status: 404 }) });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  voice.stop();
  server.stop(true);
  globalThis.fetch = realFetch;
});

describe("call queue", () => {
  test("free agents ring straight away, with a fallback when no one answers", async () => {
    const xml = await call("CA01");
    expect(xml).toContain("<Client>u1</Client><Client>u2</Client>");
    expect(xml).toContain('action="' + base + '/webhooks/twilio/rang"');

    // Both let it ring out: the caller joins the line instead of being dropped.
    const after = await twilio("/webhooks/twilio/rang", { CallSid: "CA01", DialCallStatus: "no-answer" });
    expect(after).toContain(">platform</Enqueue>");
    await twilio("/webhooks/twilio/queue/left", { CallSid: "CA01", QueueResult: "hangup" });
    expect(line()).toEqual([]);
  });

  test("when everyone is busy, callers wait in order and hear their place", async () => {
    busy = ["u1", "u2"];
    expect(await call("CA02")).toContain("<Enqueue");
    expect(await call("CA03")).toContain("<Enqueue");
    expect(await waitIn("CA02")).toContain("You are next in line.");
    expect(await waitIn("CA03")).toContain("You are number 2 in line.");
    await voice.queue.dispatch(null);
    expect(redirects).toEqual([]); // no one free
    expect(line()).toEqual(["1:CA02:waiting", "2:CA03:waiting"]);
  });

  test("a new caller doesn't jump the line even if an agent is free", async () => {
    busy = ["u2"];
    const xml = await call("CA04");
    expect(xml).toContain("<Enqueue");
    await waitIn("CA04");
  });

  test("the line is full at maxSize: the next caller gets voicemail", async () => {
    expect(await call("CA05")).toContain("<Record");
    const t = await voice.calls.transcript("CA05");
    expect(t?.queue?.outcome).toBe("full");
  });

  test("a free agent gets the longest-waiting caller", async () => {
    await voice.queue.dispatch(null);
    expect(redirects).toEqual([{ callSid: "CA02", url: `${base}/webhooks/twilio/queue/offer?agent=u1` }]);
    expect(line()).toEqual(["1:CA02:ringing", "2:CA03:waiting", "3:CA04:waiting"]);

    const offer = await twilio("/webhooks/twilio/queue/offer?agent=u1", { CallSid: "CA02" });
    expect(offer).toContain(">u1</Client>");
    expect(offer).toContain("/webhooks/twilio/queue/answered?call=CA02");
  });

  test("not answered: back in line at the same place, and that agent rests", async () => {
    const xml = await twilio("/webhooks/twilio/queue/offer-end?agent=u1", { CallSid: "CA02", DialCallStatus: "no-answer" });
    expect(xml).toContain("<Enqueue");
    expect(await waitIn("CA02")).toContain("You are next in line.");

    redirects.length = 0;
    busy = [];
    await voice.queue.dispatch(null);
    // u1 just let it ring out, so u2 gets CA02; CA03 waits for the next free agent.
    expect(redirects).toEqual([{ callSid: "CA02", url: `${base}/webhooks/twilio/queue/offer?agent=u2` }]);
  });

  test("answered: the caller leaves the line", async () => {
    await twilio("/webhooks/twilio/queue/answered?call=CA02", { CallSid: "CA99", CallStatus: "in-progress" });
    expect(line()).toEqual(["1:CA03:waiting", "2:CA04:waiting"]);
    expect((await voice.calls.transcript("CA02"))?.queue?.outcome).toBe("answered");
  });

  test("hanging up while waiting is a missed call", async () => {
    await twilio("/webhooks/twilio/queue/left", { CallSid: "CA04", QueueResult: "hangup" });
    expect(line()).toEqual(["1:CA03:waiting"]);
    expect((await voice.calls.transcript("CA04"))?.queue?.outcome).toBe("abandoned");
  });

  test("waiting too long goes to voicemail, and the message is kept", async () => {
    busy = ["u1", "u2"];
    queue = { maxSize: 3, maxWaitSec: 0 };
    redirects.length = 0;
    await voice.queue.dispatch(null);
    expect(redirects).toEqual([{ callSid: "CA03", url: `${base}/webhooks/twilio/queue/timeout` }]);
    expect(await twilio("/webhooks/twilio/queue/timeout", { CallSid: "CA03" })).toContain("<Record");

    await twilio("/webhooks/twilio/voicemail", { CallSid: "CA03", RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "12" });
    const t = await voice.calls.transcript("CA03");
    expect(t?.queue?.outcome).toBe("timeout");
    expect(t?.voicemail).toEqual({ url: "https://api.twilio.com/rec/RE1", durationSec: 12 });
  });

  test("with no line, a call no one can take goes to voicemail", async () => {
    queue = null;
    busy = ["u1", "u2"];
    expect(await call("CA06")).toContain("<Record");
    expect(await voice.calls.transcript("CA06").then((t) => t?.queue)).toBeNull();
  });
});

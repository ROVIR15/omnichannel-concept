# Voice package (`src/voice`)

Last updated: 2026-10-27

Phone calls through Twilio: agents call and answer in the browser, calls are routed to each organisation's agents, and calls can be transcribed. There's no Twilio SDK. Everything is plain `fetch`, a small JWT and a few lines of TwiML.

## Files

| File | What it does |
|---|---|
| `index.ts` | **Start here.** `initVoice()`, the only thing a host needs to import. |
| `context.ts` | What the host must provide (`VoiceOptions`) and the `VoiceUser` shape. |
| `schema.ts` | The voice tables, created automatically by `initVoice()`. |
| `routes.ts` | All HTTP endpoints. |
| `twilio.ts` | Talking to Twilio: browser token, signature check, TwiML, REST helpers. |
| `numbers.ts` | Phone numbers per organisation: add, transfer watcher, routing lookups. |
| `transcripts.ts` | Call records and transcripts. |
| `relay.ts` | An assistant (e.g. AI) answering calls, through Twilio ConversationRelay. |
| `queue.ts` | The waiting line: callers wait when everyone is busy, and go to the next free agent. |
| `queue.test.ts` | The line end to end against a fake Twilio. `bun test src/voice` |

The package imports nothing from the rest of the app. Everything it needs comes in through `initVoice()`, so another project can copy the folder and use it.

**Requirements:** [Bun](https://bun.sh), because the package uses `bun:sqlite` and `Bun.CryptoHasher`. It handles standard `Request`/`Response`, so it works with `Bun.serve` or any framework built on them (Hono, Elysia).

## Initialization

Call `initVoice()` once at startup, then pass every request to `voice.handle()`:

```ts
import { Database } from "bun:sqlite";
import { initVoice } from "./voice";

const voice = initVoice({
  // 1. A bun:sqlite database. The voice tables are created in it if missing.
  db: new Database("app.sqlite"),

  // 2. Twilio settings. Called on every use, so changes apply without a restart.
  settings: () => ({
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
    authToken: process.env.TWILIO_AUTH_TOKEN!,
    apiKeySid: process.env.TWILIO_API_KEY_SID!,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET!,
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID!,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER!, // fallback caller ID
    transcription: process.env.TWILIO_TRANSCRIPTION === "on",
  }),

  // 3. Your people.
  users: {
    get: (id) => myUsers.find(id),                    // → VoiceUser | null
    available: (orgId) => myUsers.onlineIds(orgId),    // whom a call should ring
  },

  // Optional:
  contactName: (phone) => myContacts.nameFor(phone),  // caller names in transcripts
  watchNumbers: true,                                  // check number transfers every 5 min
});

Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    const user = await mySignedInUser(req);            // → VoiceUser | null
    const res = await voice.handle(req, url, user);
    if (res) return res;
    // ... your other routes
    return new Response("not found", { status: 404 });
  },
});
```

**`VoiceUser`**: map your user to this shape:

```ts
{ id: string; orgId: string | null; name: string; role: "operator" | "admin" | "agent" }
```

| Role | Can |
|---|---|
| `operator` | see every call, manage every organisation's numbers. `orgId` is `null`. |
| `admin` | see their organisation's calls, manage its numbers |
| `agent` | make and take calls, see the calls they took |

The `id` is also the browser's calling identity. Incoming calls ring `<Client>{id}</Client>`.

**What the package checks for you:** Twilio webhook signatures, plus role and organisation on the number and call routes. **What you check:** that the user is signed in. Pass `null` for anonymous requests; webhooks need no user.

**In this app**, `src/index.ts` passes the app's SQLite database, the Settings page values, `getUser`/`availableUserIds` from `src/auth`, and caller names from the contacts table.

## Setup in Twilio

In the Twilio Console, point these at your public URL (an ngrok tunnel when local):

- TwiML App → Voice URL: `https://<host>/webhooks/twilio/voice`
- Phone number → "A call comes in": the same URL. Numbers added through the package get this set automatically.

## Endpoints

**Webhooks (Twilio calls these; checked by signature, no sign-in):**

| Method | Path | Does |
|---|---|---|
| POST | `/webhooks/twilio/voice` | Starts every call. Browser → dials the number; phone → rings agents. |
| WS | `/webhooks/twilio/relay` | The assistant's ConversationRelay socket. Checked by one-time token. |
| POST | `/webhooks/twilio/relay-end` | The assistant finished: ring people or hang up. |
| POST | `/webhooks/twilio/rang` | Free agents rang; no answer → the line or voicemail. |
| POST | `/webhooks/twilio/queue/wait` | What a waiting caller hears (place in line, music). |
| POST | `/webhooks/twilio/queue/left` | The caller left the Twilio queue (hung up, or we took them out). |
| POST | `/webhooks/twilio/queue/offer` | Ring one agent for a caller from the line. |
| POST | `/webhooks/twilio/queue/answered` | That agent picked up. |
| POST | `/webhooks/twilio/queue/offer-end` | That ring ended; not answered → back in line. |
| POST | `/webhooks/twilio/queue/timeout` | Waited too long → voicemail. |
| POST | `/webhooks/twilio/voicemail` | The recorded message. |
| POST | `/webhooks/twilio/transcription` | One transcribed sentence (or start/stop/error). |
| POST | `/webhooks/twilio/status` | Call status updates (logged). |
| POST | `/webhooks/twilio/recording` | Recording updates (logged). |

**App API (signed-in users):**

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/api/voice/token` | agent+ | Browser calling token for the signed-in user. |
| GET | `/api/voice/queue?org=` | agent+ | Who is waiting (operators: every line, or `?org=`). |
| GET | `/api/voice/calls?org=` | agent+ | Recent calls (agents: only their own). |
| GET | `/api/voice/calls/<CallSid>/transcript` | agent+ | One call's transcript JSON. |
| GET | `/api/voice/numbers?org=` | admin+ | The organisation's numbers + our Account SID. |
| POST | `/api/voice/numbers` | admin+ | Body `{ orgId, phoneNumber }`. Adds a number. |
| POST | `/api/voice/numbers/check?org=` | admin+ | Checks pending numbers now. |
| DELETE | `/api/voice/numbers/<number>?org=` | admin+ | Unlinks a number from the organisation. |

## How a call is routed

- **Incoming** (phone → our number): every call goes through `routeCall()` in `routes.ts`. Each step is an add-on, skipped when its option is off:
  1. **Assistant** (`assistant` option): the AI answers. A handoff continues at step 2.
  2. **Free agents** ring at once; first to answer wins. Free = `users.available(orgId)`, minus anyone on a call or being rung (asked from Twilio). If people are already waiting, a new caller doesn't jump the line: step 3.
  3. **The line** (`queue` option): the caller waits. See below.
  4. **Voicemail.**

  `orgForNumber(To)` finds the organisation. A number linked to no organisation is the platform line and rings everyone available.
- **Outgoing** (browser → phone): the caller ID is `callerIdFor(agent)`: the agent's organisation number, or else the platform number.

## An assistant answering calls

Pass `assistant` to `initVoice()` and an incoming call can be answered by something other than a person, e.g. an AI. The package knows only this contract (`context.ts`):

```ts
assistant: {
  answer(call) {                       // { callSid, orgId, from, to, callerName, agentsAvailable }
    if (!wantToAnswer) return null;    // null = ring people as usual
    return {
      greeting: "Hello, how can I help?",
      async *reply(callerText, signal) {   // signal aborts when the caller talks over you
        yield { say: "Sure, " };          // spoken as it arrives
        yield { handoff: "Wants to change a booking." }; // or { hangup: true }
      },
      interrupted(heard) {},               // optional: what the caller actually heard
      ended() {},                          // optional
    };
  },
},
```

And give Bun the socket:

```ts
Bun.serve({
  websocket: voice.relay.websocket,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (voice.relay.upgrade(req, url, server)) return;
    // ...
  },
});
```

**One call:** the voice webhook calls `answer()`. On yes it returns `<Connect><ConversationRelay>` with a one-time token; Twilio opens `/webhooks/twilio/relay` (a WebSocket) and sends that token back in `setup`. Twilio turns each caller sentence into text, we stream the reply back as text, Twilio speaks it. A handoff or hangup ends the session; Twilio then posts to `/webhooks/twilio/relay-end`, which says a fixed line and rings people (handoff, or the relay failed) or hangs up.

**Transcript:** the assistant's lines are stored with speaker `assistant`, the caller's as `customer`. After a handoff, Real-Time Transcription (if on) adds the person's part. The handoff summary is in the transcript's `handoff` field.

**Twilio setup:** ConversationRelay needs the *Predictive and Generative AI/ML Features Addendum* accepted once per account (Console → Voice → Settings → General). Nothing else: the WebSocket URL is in the TwiML, on the same host as the voice webhook.

**In this app**, `src/call-assistant.ts` is the assistant: one `ai.session()` per call with `transfer_to_agent` and `end_call` tools. Settings → AI provider → *AI Answers Calls*: `off`, `always`, or `when-no-agents`.

## The waiting line

```ts
initVoice({ …, queue: (orgId) => ({ maxWaitSec: 300, maxSize: 10 }) }); // null for an org = no line
```

- The caller is put in a Twilio queue (`<Enqueue>`), named `org-<id>` or `platform`. Twilio holds them and asks `/queue/wait` what to play: their place, then hold music.
- **The order is ours** (`voice_queue_waits`, by join time), not Twilio's. `dispatch(orgId)` takes the longest waiting caller out of the Twilio queue and rings one free agent for them.
- **Not answered:** the caller goes back in at the same place. That agent isn't offered another caller for 30 seconds.
- **Waited longer than `maxWaitSec`, or the line has `maxSize` people:** voicemail.
- **Hung up while waiting:** saved as `abandoned`, a missed call.
- `dispatch()` runs when someone joins, when a ring ends, and every 5 seconds. Call `voice.queue.dispatch(orgId)` yourself when an agent becomes available, so the next caller rings at once.

The transcript document has `queue` (`outcome`: answered, abandoned, timeout, full; `waitSec`) and `voicemail` (`url`, `durationSec`). Calls in the list have `voicemail: true`.

**Twilio setup:** none. Twilio makes each queue on first use. Real-Time Transcription, if on, starts again on each ring from the line, so hold music isn't transcribed.

## Using it from other code

`initVoice()` returns the handler plus the main functions:

```ts
voice.handle(req, url, user);                     // → Response, or null if not a voice route

await voice.numbers.add("acme", "+1 800 555 0123"); // → { ok, number } or { ok: false, error }
voice.numbers.list("acme");                         // → the organisation's numbers
voice.numbers.orgFor("+18005550123");               // → "acme", or null
voice.numbers.callerIdFor(user);                    // → caller ID for this user's outgoing calls
await voice.numbers.checkPending();                 // → check transfers now

voice.calls.list(user, "acme");                     // → recent calls this user may see (database only)
await voice.calls.transcript("CA123…");             // → full transcript document, or null
await voice.calls.canSee(user, "CA123…");           // → true / false

voice.twilio.missingSettings();                     // → e.g. ["API Key SID"]
await voice.twilio.get("/Calls/CA123….json");       // → any Twilio REST GET under the account

voice.queue.list("acme");                           // who is waiting, in order
await voice.queue.dispatch("acme");                 // offer waiting callers to free agents now

voice.stop();                                       // stop background work (tests)
```

## Browser side

The package serves the API only, not the calling page. The browser:

1. Fetches `GET /api/voice/token` → `{ token, identity, phoneNumber }`.
2. Starts the [Twilio Voice JS SDK](https://www.twilio.com/docs/voice/sdk/javascript) `Device` with that token, then calls `device.register()` to receive calls.
3. Calls out with `device.connect({ params: { To: "+18005550123" } })`.

`src/web/voice.html` in this app is a working example.

## Database tables

- `voice_calls`: one row per call (direction, numbers, organisation, agent, transcript status).
- `voice_transcript_segments`: one row per transcribed sentence.
- `voice_numbers`: organisation phone numbers (`pending` or `active`).

- `voice_queue_waits`: one row per caller who waited in line (or found it full), with the outcome.

All are created by `initVoice()` (`schema.ts`).

## More detail

- `docs/call-channel/call-transcripts.md`: the transcript format and the speaker-label gotcha.
- `docs/call-channel/connect-number.md`: how number transfer works.
- `docs/call-channel/onboard-phone-number.md`: the onboarding steps for a new client.
- `src/ai/README.md`: the AI package, and how it will answer calls through this package.

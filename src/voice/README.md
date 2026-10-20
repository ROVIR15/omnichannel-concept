# Voice package (`src/voice`)

Last updated: 2026-10-20

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
| POST | `/webhooks/twilio/transcription` | One transcribed sentence (or start/stop/error). |
| POST | `/webhooks/twilio/status` | Call status updates (logged). |
| POST | `/webhooks/twilio/recording` | Recording updates (logged). |

**App API (signed-in users):**

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/api/voice/token` | agent+ | Browser calling token for the signed-in user. |
| GET | `/api/voice/calls?org=` | agent+ | Recent calls (agents: only their own). |
| GET | `/api/voice/calls/<CallSid>/transcript` | agent+ | One call's transcript JSON. |
| GET | `/api/voice/numbers?org=` | admin+ | The organisation's numbers + our Account SID. |
| POST | `/api/voice/numbers` | admin+ | Body `{ orgId, phoneNumber }`. Adds a number. |
| POST | `/api/voice/numbers/check?org=` | admin+ | Checks pending numbers now. |
| DELETE | `/api/voice/numbers/<number>?org=` | admin+ | Unlinks a number from the organisation. |

## How a call is routed

- **Incoming** (phone → our number): `orgForNumber(To)` finds the organisation, and `availableUserIds(orgId)` gives the agents to ring. Every available agent rings at once; the first to answer gets the call. A number linked to no organisation rings everyone available.
- **Outgoing** (browser → phone): the caller ID is `callerIdFor(agent)`: the agent's organisation number, or else the platform number.

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

voice.stop();                                       // stop the background watcher (tests)
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

All three are created by `initVoice()` (`schema.ts`).

## More detail

- `docs/call-channel/call-transcripts.md`: the transcript format and the speaker-label gotcha.
- `docs/call-channel/connect-number.md`: how number transfer works.
- `docs/call-channel/onboard-phone-number.md`: the onboarding steps for a new client.

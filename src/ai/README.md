# AI package (`src/ai`)

Last updated: 2026-10-27

Talk to any AI model by giving it a **link, a key and a model name**. There's no vendor SDK and no lock-in: it uses plain `fetch` with the two API formats almost every provider speaks.

| Format | Providers (examples) | Link |
|---|---|---|
| `openai` (Chat Completions) | OpenAI, Azure OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, Gemini (OpenAI endpoint), Ollama, vLLM, LM Studio | `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` |
| `anthropic` (Messages) | Anthropic Claude | `https://api.anthropic.com/v1` |

The format is picked automatically: `anthropic` for `api.anthropic.com` links, `openai` for everything else. Set `protocol` to override.

## Files

| File | What it does |
|---|---|
| `index.ts` | **Start here.** `initAi()` and the public API. |
| `types.ts` | Provider-neutral messages, tools and events. |
| `session.ts` | A conversation: history, tool calls, interruptions. |
| `protocols/openai.ts` | The OpenAI-compatible wire format. |
| `protocols/anthropic.ts` | The Anthropic wire format. |
| `sse.ts` | Reading streamed replies (Server-Sent Events). |

Like the voice package, it imports nothing from the rest of the app, and it needs Bun or any runtime with `fetch`.

## Initialization

```ts
import { initAi } from "./ai";

const ai = initAi({
  // Called on every request, so a settings change applies at once. Null = not set up.
  provider: () => ({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.AI_API_KEY!,
    model: "meta-llama/llama-3.1-70b-instruct",
    // protocol: "openai" | "anthropic",   optional
    // maxTokens: 1024,                     optional
    // headers: { "HTTP-Referer": "…" },    optional
  }),
});
```

**In this app**, the values come from **Settings → AI provider** (or `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_PROTOCOL` in `.env`). **Test connection** on that page calls `POST /api/ai/test` (operators only).

## Using it

**One question, one answer:**
```ts
const { text } = await ai.complete({
  system: "You answer in one sentence.",
  messages: [{ role: "user", content: "What are your opening hours?" }],
});
```

**Streamed**, word by word as the model writes:
```ts
for await (const ev of ai.stream({ messages: [{ role: "user", content: "Hi" }] })) {
  if (ev.type === "text") process.stdout.write(ev.text);
  if (ev.type === "done") console.log("\nfinished:", ev.finish);
}
```

**A conversation with tools.** The session keeps the history and runs the tools for you:
```ts
const session = ai.session({
  system: "You are the phone agent for Delta Shop. Short sentences.",
  tools: [{
    name: "transfer_to_agent",
    description: "Hand the call to a person.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    run: ({ summary }) => ({ stop: true, result: `transferring: ${summary}` }), // stop = end this turn
  }],
});

for await (const ev of session.send("I want to talk to a human", { signal })) {
  if (ev.type === "text") speak(ev.text);                          // stream to the caller
  if (ev.type === "tool") console.log(ev.call.name, ev.result);
  if (ev.type === "done" && ev.finish === "tool_stop") handOver(ev.stoppedBy);
}
```

| Session feature | How |
|---|---|
| Tool result | `run()` returns text for the model, or `{ stop: true }` to end the turn |
| Interruption | abort the `signal`. The unfinished reply is left out of the history, and the next turn starts with a note: "Your last reply was cut off after: …" |
| Extra context | `session.note("The caller is a VIP")`, added to the next turn |
| History | `session.history()` |

**Errors** throw `AiError`, with `status` set for HTTP errors (e.g. 401 for a wrong key).

## How it works with the voice package

The two packages **don't import each other**. The host app (`src/index.ts`) connects them:

```
                   ┌──────────────── src/index.ts (host) ────────────────┐
                   │                                                     │
                   │   const ai    = initAi({ provider })                │
                   │   const voice = initVoice({ …, assistant })         │
                   │                                  ▲                  │
                   │        assistant = small bridge: │                  │
                   │        org instructions + tools ─┘                  │
                   └─────────────────────────────────────────────────────┘
                          │                                   │
            ┌─────────────▼──────────────┐       ┌────────────▼─────────────┐
            │       VOICE package        │       │        AI package        │
            │ phone calls, Twilio, who   │──────▶│ any model by link: one   │
            │ rings, transcripts         │ text  │ conversation per call,   │
            │                            │◀──────│ tools, streaming         │
            │ knows: "an assistant can   │ reply │ knows nothing about      │
            │ answer"                    │       │ phones                   │
            └────────────────────────────┘       └──────────────────────────┘
```

**What each one knows:**
- **Voice** only knows that "an assistant" can answer a call. It hands the assistant what the caller said and speaks back whatever comes out. Its contract is a small interface: start a call, reply to the caller, hand over to a person.
- **AI** only knows conversations. It has no idea a phone is involved.
- **The bridge** in the host is a few lines. For each call it creates `ai.session()` with the organisation's instructions and a `transfer_to_agent` tool. When that tool stops the turn, it tells voice to ring the agents.

**Why keep them apart:**
- Either package can be swapped or reused. The AI package could also answer WhatsApp or email, and voice can run without AI.
- Changing provider is a settings change, not a code change.

**One call:**
1. A call comes in → voice asks the bridge "should the AI answer?"
2. The caller speaks → Twilio turns it into text → voice → bridge → `session.send(text)`.
3. Reply text streams back → voice → Twilio speaks it.
4. The AI calls `transfer_to_agent` → the bridge tells voice to ring the agents, passing the summary.

The bridge is `src/call-assistant.ts`; the voice side is `src/voice/relay.ts`. Settings → AI provider has the switch (`AI Answers Calls`: off, always, when-no-agents), the greeting and the instructions. Per-organisation instructions are a later step; for now the organisation's name goes into the prompt.

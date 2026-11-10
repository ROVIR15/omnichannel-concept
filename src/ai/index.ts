// The AI package's front door. Give initAi() a function that returns where
// the model lives (a link, a key, a model name); it speaks to any
// OpenAI-compatible or Anthropic API. No vendor SDK. See README.md.

import { streamAnthropic } from "./protocols/anthropic";
import { streamOpenAi } from "./protocols/openai";
import { createSession, type AiSessionOptions } from "./session";
import { AiError, type AiEvent, type AiFinish, type AiProtocol, type AiProviderConfig, type AiRequest } from "./types";

export type { AiSession, AiSessionEvent, AiSessionOptions, AiTool, AiToolResult } from "./session";
export {
  AiError, type AiAssistantMessage, type AiEvent, type AiFinish, type AiMessage, type AiProtocol,
  type AiProviderConfig, type AiRequest, type AiToolCall, type AiToolSpec,
} from "./types";

export interface AiOptions {
  /** Where the model lives. Called on every request, so a settings change
   *  applies at once. Null = AI not set up. */
  provider: () => AiProviderConfig | null;
}

/** "anthropic" for api.anthropic.com links, else the OpenAI-compatible format. */
export function protocolOf(config: AiProviderConfig): AiProtocol {
  if (config.protocol) return config.protocol;
  try {
    return new URL(config.baseUrl).hostname.endsWith("anthropic.com") ? "anthropic" : "openai";
  } catch {
    return "openai";
  }
}

export function initAi(options: AiOptions) {
  const current = (override?: AiProviderConfig) => {
    const config = override ?? options.provider();
    if (!config?.baseUrl || !config.model) throw new AiError("AI provider is not set up: a base URL and a model are required");
    return config;
  };

  /** One reply, streamed: text pieces, then `done` with the whole message. */
  function stream(req: AiRequest, provider?: AiProviderConfig): AsyncGenerator<AiEvent> {
    const config = current(provider);
    return protocolOf(config) === "anthropic" ? streamAnthropic(config, req) : streamOpenAi(config, req);
  }

  /** One reply, all at once. */
  async function complete(req: AiRequest, provider?: AiProviderConfig): Promise<{ text: string; finish: AiFinish }> {
    for await (const ev of stream(req, provider)) {
      if (ev.type === "done") return { text: ev.message.content, finish: ev.finish };
    }
    throw new AiError("the provider ended the stream without a reply");
  }

  return {
    /** True when a base URL and model are set. */
    configured: () => {
      const c = options.provider();
      return Boolean(c?.baseUrl && c.model);
    },
    stream,
    complete,
    /** A conversation with history and tools. */
    session: (sessionOptions: AiSessionOptions = {}, provider?: AiProviderConfig) =>
      createSession((req) => stream(req, provider), sessionOptions),

    /** Sends a tiny prompt and reports the reply and how long it took. */
    async test(provider?: AiProviderConfig) {
      const started = Date.now();
      try {
        const config = current(provider);
        const { text } = await complete({ messages: [{ role: "user", content: "Reply with the single word: OK" }] }, config);
        return { ok: true as const, protocol: protocolOf(config), model: config.model, reply: text.trim(), ms: Date.now() - started };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
      }
    },
  };
}

export type Ai = ReturnType<typeof initAi>;

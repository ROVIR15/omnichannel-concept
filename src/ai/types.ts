// Provider-neutral shapes. Every protocol adapter turns these into its own
// wire format and back, so callers never see a vendor's request body.

/** Wire format of the provider's API. Nearly every provider speaks one of these. */
export type AiProtocol = "openai" | "anthropic";

/** Where and how to reach a model: a link, a key and a model name. */
export interface AiProviderConfig {
  /** API base, e.g. https://api.openai.com/v1, https://api.anthropic.com/v1,
   *  https://openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Default: "anthropic" when the link is api.anthropic.com, else "openai". */
  protocol?: AiProtocol;
  /** Reply length cap. Default 1024. */
  maxTokens?: number;
  /** Extra request headers some providers want (e.g. OpenRouter's HTTP-Referer). */
  headers?: Record<string, string>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: AiToolCall[];
  /** The provider's own form of this reply (e.g. Anthropic thinking blocks),
   *  sent back unchanged on the next request to the same protocol. */
  raw?: { protocol: AiProtocol; content: unknown };
}

export type AiMessage =
  | { role: "user"; content: string }
  | AiAssistantMessage
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface AiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiRequest {
  system?: string;
  messages: AiMessage[];
  tools?: AiToolSpec[];
  /** Abort to stop generating, e.g. when a caller talks over the reply. */
  signal?: AbortSignal;
}

/** Why the model stopped. */
export type AiFinish = "stop" | "tool_calls" | "length" | "refused" | "other";

export type AiEvent =
  | { type: "text"; text: string }
  | { type: "done"; message: AiAssistantMessage; finish: AiFinish };

/** A provider answered with an HTTP error, or the stream broke. */
export class AiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "AiError";
  }
}

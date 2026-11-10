// OpenAI-compatible Chat Completions (POST {base}/chat/completions). Spoken by
// OpenAI, Azure OpenAI, Groq, Together, OpenRouter, DeepSeek, Mistral,
// Ollama, vLLM, LM Studio and Gemini's OpenAI endpoint, among others.

import { joinUrl, postStream, readSse } from "../sse";
import { AiError, type AiEvent, type AiFinish, type AiMessage, type AiProviderConfig, type AiRequest, type AiToolCall } from "../types";

function toWire(system: string | undefined, messages: AiMessage[]) {
  const out: unknown[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        }),
      });
    }
  }
  return out;
}

const FINISH: Record<string, AiFinish> = {
  stop: "stop", tool_calls: "tool_calls", function_call: "tool_calls", length: "length", content_filter: "refused",
};

export async function* streamOpenAi(config: AiProviderConfig, req: AiRequest): AsyncGenerator<AiEvent> {
  const body = {
    model: config.model,
    messages: toWire(req.system, req.messages),
    stream: true,
    ...(config.maxTokens && { max_tokens: config.maxTokens }),
    ...(req.tools?.length && {
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }),
  };
  const res = await postStream(joinUrl(config.baseUrl, "chat/completions"),
    { ...(config.apiKey && { authorization: `Bearer ${config.apiKey}` }), ...config.headers }, body, req.signal);

  let text = "";
  let finish: AiFinish = "other";
  // Tool calls arrive in pieces, keyed by index: id and name first, then the arguments.
  const calls: { id: string; name: string; args: string }[] = [];

  for await (const { data } of readSse(res)) {
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new AiError(chunk.error.message ?? JSON.stringify(chunk.error));
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      yield { type: "text", text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = FINISH[choice.finish_reason] ?? "other";
  }

  const toolCalls: AiToolCall[] = calls.filter(Boolean).map((c, i) => ({
    id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args),
  }));
  if (toolCalls.length && finish === "stop") finish = "tool_calls"; // some providers say "stop" anyway
  yield { type: "done", finish, message: { role: "assistant", content: text, ...(toolCalls.length && { toolCalls }) } };
}

function parseArgs(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" ? v : {};
  } catch {
    return { _unparsed: args };
  }
}

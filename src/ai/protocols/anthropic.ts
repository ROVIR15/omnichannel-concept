// Anthropic Messages (POST {base}/messages). Each reply's content blocks
// (text, tool_use, thinking) are kept whole in `raw` and sent back unchanged,
// which the API requires for thinking blocks across tool calls.

import { joinUrl, postStream, readSse } from "../sse";
import { AiError, type AiEvent, type AiFinish, type AiMessage, type AiProviderConfig, type AiRequest, type AiToolCall } from "../types";

const API_VERSION = "2023-06-01";

type Block = Record<string, any>;

function toWire(messages: AiMessage[]) {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  // Consecutive tool results and user text belong in one user turn.
  const userTurn = () => {
    const last = out.at(-1);
    if (last?.role === "user") return last.content;
    const turn = { role: "user" as const, content: [] as Block[] };
    out.push(turn);
    return turn.content;
  };
  for (const m of messages) {
    if (m.role === "user") userTurn().push({ type: "text", text: m.content });
    else if (m.role === "tool") {
      userTurn().push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError && { is_error: true }) });
    } else if (m.raw?.protocol === "anthropic") out.push({ role: "assistant", content: m.raw.content as Block[] });
    else {
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
        ],
      });
    }
  }
  return out;
}

const FINISH: Record<string, AiFinish> = {
  end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "refused",
};

export async function* streamAnthropic(config: AiProviderConfig, req: AiRequest): AsyncGenerator<AiEvent> {
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? 1024,
    stream: true,
    ...(req.system && { system: req.system }),
    messages: toWire(req.messages),
    ...(req.tools?.length && {
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
  };
  const res = await postStream(joinUrl(config.baseUrl, "messages"),
    { "x-api-key": config.apiKey, "anthropic-version": API_VERSION, ...config.headers }, body, req.signal);

  const blocks: Block[] = [];
  const toolJson: string[] = [];
  let finish: AiFinish = "other";

  for await (const { event, data } of readSse(res)) {
    const e = JSON.parse(data);
    if (event === "error" || e.type === "error") throw new AiError(e.error?.message ?? data);
    if (e.type === "content_block_start") {
      blocks[e.index] = { ...e.content_block };
      if (e.content_block.type === "tool_use") toolJson[e.index] = "";
    } else if (e.type === "content_block_delta") {
      const b = blocks[e.index]!;
      const d = e.delta;
      if (d.type === "text_delta") {
        b.text = (b.text ?? "") + d.text;
        yield { type: "text", text: d.text };
      } else if (d.type === "input_json_delta") toolJson[e.index] += d.partial_json;
      else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
      else if (d.type === "signature_delta") b.signature = d.signature;
    } else if (e.type === "content_block_stop" && blocks[e.index]?.type === "tool_use") {
      const json = toolJson[e.index] ?? "";
      try { blocks[e.index]!.input = json.trim() ? JSON.parse(json) : {}; } catch { blocks[e.index]!.input = { _unparsed: json }; }
    } else if (e.type === "message_delta" && e.delta?.stop_reason) {
      finish = FINISH[e.delta.stop_reason] ?? "other";
    }
  }

  const content = blocks.filter(Boolean);
  const text = content.filter((b) => b.type === "text").map((b) => b.text as string).join("");
  const toolCalls: AiToolCall[] = content.filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
  yield {
    type: "done",
    finish,
    message: { role: "assistant", content: text, ...(toolCalls.length && { toolCalls }), raw: { protocol: "anthropic", content } },
  };
}

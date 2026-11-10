// A conversation: keeps the history, runs tool calls, and streams the text
// back. History is append-only — an interrupted reply is never edited after
// the fact; a note on the next turn tells the model what was cut off.

import type { AiEvent, AiFinish, AiMessage, AiRequest, AiToolCall, AiToolSpec } from "./types";

/** What a tool returns: text for the model, or `stop` to end the turn after
 *  it (e.g. the call was handed to a person, nothing more to say). */
export type AiToolResult = string | { stop: true; result?: string };

export interface AiTool extends AiToolSpec {
  /** `input` comes from the model: check it before acting on it. */
  run(input: Record<string, unknown>): Promise<AiToolResult> | AiToolResult;
}

export interface AiSessionOptions {
  system?: string;
  tools?: AiTool[];
  /** Tool calls allowed in one turn before giving up. Default 5. */
  maxToolRounds?: number;
}

export type AiSessionEvent =
  | { type: "text"; text: string }
  | { type: "tool"; call: AiToolCall; result: string; isError: boolean }
  | { type: "done"; finish: AiFinish | "tool_stop" | "aborted"; text: string; stoppedBy?: AiToolCall };

type Stream = (req: AiRequest) => AsyncGenerator<AiEvent>;

export function createSession(stream: Stream, options: AiSessionOptions = {}) {
  const messages: AiMessage[] = [];
  const tools = options.tools ?? [];
  const maxRounds = options.maxToolRounds ?? 5;
  let notes: string[] = [];

  /** Context for the next turn, without touching history (e.g. "the caller
   *  only heard: …"). */
  function note(text: string) {
    notes.push(text);
  }

  async function* send(userText: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<AiSessionEvent> {
    const prefix = notes.length ? `[${notes.join(" ")}]\n` : "";
    notes = [];
    messages.push({ role: "user", content: prefix + userText });

    let spoken = "";
    for (let round = 0; round <= maxRounds; round++) {
      let done: Extract<AiEvent, { type: "done" }> | null = null;
      let partial = "";
      try {
        for await (const ev of stream({ system: options.system, messages, tools, signal: opts.signal })) {
          if (ev.type === "text") {
            partial += ev.text;
            yield ev;
          } else done = ev;
        }
      } catch (err) {
        if (opts.signal?.aborted) {
          // The reply never completed, so it isn't added to history; the model
          // learns what it had started saying from a note instead.
          spoken += partial;
          if (spoken) note(`Your last reply was cut off after: "${spoken.trim()}".`);
          yield { type: "done", finish: "aborted", text: spoken };
          return;
        }
        throw err;
      }
      if (!done) return;

      messages.push(done.message);
      spoken += done.message.content;
      const calls = done.message.toolCalls ?? [];
      if (done.finish !== "tool_calls" || !calls.length) {
        yield { type: "done", finish: done.finish, text: spoken };
        return;
      }

      let stoppedBy: AiToolCall | undefined;
      for (const call of calls) {
        const tool = tools.find((t) => t.name === call.name);
        let result: string;
        let isError = false;
        try {
          if (!tool) throw new Error(`unknown tool ${call.name}`);
          const out = await tool.run(call.input);
          if (typeof out === "string") result = out;
          else {
            result = out.result ?? "done";
            stoppedBy ??= call;
          }
        } catch (err) {
          result = err instanceof Error ? err.message : String(err);
          isError = true;
        }
        messages.push({ role: "tool", toolCallId: call.id, content: result, ...(isError && { isError }) });
        yield { type: "tool", call, result, isError };
      }
      if (stoppedBy) {
        yield { type: "done", finish: "tool_stop", text: spoken, stoppedBy };
        return;
      }
    }
    yield { type: "done", finish: "other", text: spoken };
  }

  return {
    send,
    note,
    /** The conversation so far, as sent to the provider. */
    history: (): readonly AiMessage[] => messages,
  };
}

export type AiSession = ReturnType<typeof createSession>;

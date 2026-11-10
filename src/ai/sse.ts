// Server-Sent Events, as both protocols stream them: blank-line separated
// events, each with an optional `event:` name and one or more `data:` lines.

import { AiError } from "./types";

export interface SseEvent {
  event: string;
  data: string;
}

export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.body) throw new AiError("the provider sent an empty stream", res.status);
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
    }
  }
  const last = parseBlock(buffer);
  if (last) yield last;
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/** POST JSON and fail with the provider's own error text on a non-2xx. */
export async function postStream(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AiError(`${res.status} from ${new URL(url).host}: ${text.slice(0, 500)}`, res.status);
  }
  return res;
}

export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path}`;

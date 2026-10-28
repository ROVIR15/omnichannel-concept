// The bridge between the AI and voice packages: an AI that answers phone
// calls. Voice asks whether to answer; we say yes per Settings, then turn each
// caller sentence into an AI turn and the AI's tools into a handoff or hangup.
// Neither package knows about the other; see src/ai/README.md.

import type { Ai } from "./ai";
import type { VoiceAssistant, VoiceAssistantAction } from "./voice";
import { appSetting } from "./settings";
import { getOrg } from "./store";

/** off | always | when-no-agents */
export type CallAnswering = "off" | "always" | "when-no-agents";

export function callAnswering(): CallAnswering {
  const mode = appSetting("ai_call_answering").trim().toLowerCase();
  if (mode === "when-no-agents") return mode;
  // "on" is what people type for the other on/off settings.
  return /^(always|on|true|yes|1)$/.test(mode) ? "always" : "off";
}

const DEFAULT_GREETING = "Hello, thanks for calling. How can I help you today?";

function systemPrompt(orgName: string | null, caller: string, instructions: string): string {
  return [
    `You answer the phone for ${orgName ?? "our company"}. You are an AI assistant; say so if asked.`,
    "The caller hears you through text-to-speech, so:",
    "- Keep replies to one or two short sentences. Ask one question at a time.",
    "- Plain spoken words only: no lists, markdown, emoji or links.",
    "- Say numbers, dates and times the way a person would say them aloud.",
    "If the caller asks for a person, or you can't help, call transfer_to_agent with a one-sentence summary for the colleague. Don't announce the transfer yourself; the phone system does.",
    "When the caller is done, call end_call. Don't say goodbye first; the phone system does.",
    "Never make up prices, policies or account details. If you don't know, offer a colleague.",
    `The caller: ${caller}.`,
    instructions && `Instructions from the business:\n${instructions}`,
  ].filter(Boolean).join("\n");
}

export function callAssistant(ai: Ai, available: (orgId: string | null) => string[]): VoiceAssistant {
  return {
    answer(call) {
      const mode = callAnswering();
      if (mode === "off" || !ai.configured()) return null;
      if (mode === "when-no-agents" && call.agentsAvailable > 0) return null;

      const orgName = call.orgId ? getOrg(call.orgId)?.name ?? null : null;
      const caller = call.callerName ? `${call.callerName} (${call.from})` : call.from || "unknown number";
      let outcome: VoiceAssistantAction | null = null;

      const session = ai.session({
        system: systemPrompt(orgName, caller, appSetting("ai_call_instructions").trim()),
        tools: [
          {
            name: "transfer_to_agent",
            description: "Hand the call to a person at the business.",
            parameters: {
              type: "object",
              properties: { summary: { type: "string", description: "One sentence for the colleague: who is calling and what they need." } },
              required: ["summary"],
            },
            run: ({ summary }) => {
              // Checked now, not at the start: people come and go during a call.
              if (available(call.orgId).length === 0) {
                return "No one is available right now. Tell the caller, offer to take a message, and keep helping.";
              }
              outcome = { handoff: String(summary ?? "").slice(0, 500) || "The caller asked for a person." };
              return { stop: true, result: "transferring" };
            },
          },
          {
            name: "end_call",
            description: "Hang up, once the caller has nothing more to ask.",
            parameters: { type: "object", properties: {} },
            run: () => {
              outcome = { hangup: true };
              return { stop: true, result: "ending call" };
            },
          },
        ],
      });

      return {
        greeting: appSetting("ai_call_greeting").trim() || DEFAULT_GREETING,
        async *reply(text, signal) {
          for await (const ev of session.send(text, { signal })) {
            if (ev.type === "text") yield { say: ev.text };
            if (ev.type === "done" && ev.finish === "tool_stop" && outcome) yield outcome;
          }
        },
        interrupted(heard) {
          session.note(heard ? `The caller interrupted you; they only heard: "${heard}".` : "The caller interrupted you before hearing anything.");
        },
      };
    },
  };
}

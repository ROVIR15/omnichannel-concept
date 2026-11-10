// What the voice package needs from the app that hosts it: a database, the
// Twilio settings, and a way to look up people. initVoice() sets these once;
// every module reads them through voiceDeps(), so the package never imports
// the host app's own modules.

import type { Database } from "bun:sqlite";

export type VoiceRole = "operator" | "admin" | "agent";

/** A signed-in person, as the voice package sees them. `orgId` is null for
 *  an operator, who runs the platform and sees every organisation. */
export interface VoiceUser {
  id: string;
  orgId: string | null;
  name: string;
  role: VoiceRole;
}

/** Twilio settings. Read on every call, so a change applies without a restart. */
export interface VoiceSettings {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  /** The platform number: caller ID when an organisation has none of its own. */
  phoneNumber: string;
  /** Transcribe every call (Twilio Real-Time Transcription). */
  transcription: boolean;
}

/** An incoming call, as an assistant sees it before answering. */
export interface VoiceAssistantCallInfo {
  callSid: string;
  /** Null for the platform number. */
  orgId: string | null;
  from: string;
  to: string;
  callerName: string | null;
  /** How many people the call would ring right now. */
  agentsAvailable: number;
}

/** What an assistant does next: speak, hand the call to people, or hang up.
 *  The voice package says a short fixed line before handing over or hanging up. */
export type VoiceAssistantAction =
  | { say: string }
  | { handoff: string } // a one-line summary for the person who answers
  | { hangup: true };

/** One answered call. */
export interface VoiceAssistantCall {
  /** Spoken as soon as the call connects. */
  greeting: string;
  /** The caller finished a sentence. Yield the reply in pieces as it is
   *  written; `signal` aborts when the caller talks over it. */
  reply(callerText: string, signal: AbortSignal): AsyncIterable<VoiceAssistantAction>;
  /** The caller talked over the reply and heard only `heard`. */
  interrupted?(heard: string): void;
  /** The assistant's part of the call is over (handoff, hangup or caller gone). */
  ended?(): void;
}

/** Something that can answer calls, e.g. an AI model. The voice package
 *  knows nothing else about it. */
export interface VoiceAssistant {
  /** Called for every incoming call. Return null to ring people as usual. */
  answer(call: VoiceAssistantCallInfo): VoiceAssistantCall | null;
}

export interface VoiceOptions {
  /** bun:sqlite database. The voice tables are created in it if missing. */
  db: Database;
  settings: () => VoiceSettings;
  users: {
    get(id: string): VoiceUser | null;
    /** Whom an incoming call should ring: the organisation's available
     *  people, or everyone available when `orgId` is null. */
    available(orgId: string | null): string[];
  };
  /** A known name for a caller's number, e.g. from the host's contacts. */
  contactName?: (phoneNumber: string) => string | null;
  /** Answers incoming calls before (or instead of) ringing people. See relay.ts. */
  assistant?: VoiceAssistant;
  /** Check pending number transfers in the background. Default true. */
  watchNumbers?: boolean;
}

let deps: VoiceOptions | null = null;

export function setVoiceDeps(options: VoiceOptions) {
  deps = options;
}

export function voiceDeps(): VoiceOptions {
  if (!deps) throw new Error("voice: call initVoice() before using the voice package");
  return deps;
}

export const db = () => voiceDeps().db;

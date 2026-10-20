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

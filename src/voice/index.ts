// The voice package's front door. Call initVoice() once at startup with a
// database, the Twilio settings and a user lookup; it creates the voice
// tables, starts the number-transfer watcher and returns the request handler
// plus the functions other code may use. See README.md.

import { setVoiceDeps, type VoiceOptions } from "./context";
import { addNumber, callerIdFor, checkPendingNumbers, listNumbers, orgForNumber, removeNumber, startNumberWatcher } from "./numbers";
import { handleVoiceRoutes } from "./routes";
import { relayWebsocket, upgradeRelay } from "./relay";
import { ensureVoiceSchema } from "./schema";
import { buildCallTranscript, canSeeCall, listCalls } from "./transcripts";
import { missingForCalls, twilioGet, twilioPost } from "./twilio";

export type {
  VoiceAssistant, VoiceAssistantAction, VoiceAssistantCall, VoiceAssistantCallInfo, VoiceOptions, VoiceRole, VoiceSettings, VoiceUser,
} from "./context";
export type { RelaySocketData } from "./relay";
export type { NumberStatus, VoiceNumber } from "./numbers";

export function initVoice(options: VoiceOptions) {
  setVoiceDeps(options);
  ensureVoiceSchema(options.db);
  const stopWatcher = options.watchNumbers === false ? () => {} : startNumberWatcher();

  return {
    /** Serves every voice route; null when the request isn't one of them.
     *  `user` = the signed-in person, or null (webhooks need none). */
    handle: handleVoiceRoutes,

    /** The assistant's socket (ConversationRelay). Pass `websocket` to
     *  Bun.serve and call `upgrade()` first thing in fetch. */
    relay: { upgrade: upgradeRelay, websocket: relayWebsocket },

    numbers: { add: addNumber, remove: removeNumber, list: listNumbers, checkPending: checkPendingNumbers, orgFor: orgForNumber, callerIdFor },
    calls: { list: listCalls, transcript: buildCallTranscript, canSee: canSeeCall },
    twilio: { get: twilioGet, post: twilioPost, missingSettings: missingForCalls },

    /** Stop background work (the number watcher), e.g. in tests. */
    stop: stopWatcher,
  };
}

export type Voice = ReturnType<typeof initVoice>;

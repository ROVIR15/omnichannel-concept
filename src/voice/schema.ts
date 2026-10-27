// The voice package's own tables. Created by initVoice() in whatever
// database the host passes, so the package needs no migration of its own.
// Organisation ids are plain text: the host's organisations table, if it has
// one, is not referenced.

import type { Database } from "bun:sqlite";

export function ensureVoiceSchema(db: Database) {
  db.exec(`
-- One row per call our TwiML handled; Twilio's call record is cached in
-- details once the call ends. org_id is NULL for the platform number.
CREATE TABLE IF NOT EXISTS voice_calls (
  call_sid           TEXT PRIMARY KEY,
  direction          TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  customer_number    TEXT NOT NULL,
  business_number    TEXT NOT NULL,
  customer_location  TEXT NOT NULL DEFAULT '{}',
  caller_name        TEXT,
  agent_user_id      TEXT,
  org_id             TEXT,
  transcript_status  TEXT NOT NULL
                     CHECK (transcript_status IN ('disabled', 'in-progress', 'completed', 'failed')),
  transcript_error   TEXT,
  language           TEXT,
  engine             TEXT,
  details            TEXT,
  assistant_handoff  TEXT,
  created_at         INTEGER NOT NULL
);

-- Phone numbers per organisation. A number waits as pending until Twilio has
-- moved it into our account, then turns active.
CREATE TABLE IF NOT EXISTS voice_numbers (
  phone_number     TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  twilio_sid       TEXT,
  error            TEXT,
  requested_at     INTEGER NOT NULL,
  connected_at     INTEGER,
  last_checked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voice_numbers_org ON voice_numbers(org_id);

-- Final sentences only. Twilio retries webhooks, so the key makes repeats no-ops.
CREATE TABLE IF NOT EXISTS voice_transcript_segments (
  call_sid           TEXT NOT NULL REFERENCES voice_calls(call_sid) ON DELETE CASCADE,
  transcription_sid  TEXT NOT NULL,
  track              TEXT NOT NULL,
  sequence_id        INTEGER NOT NULL,
  text               TEXT NOT NULL,
  confidence         REAL,
  at                 TEXT NOT NULL,
  PRIMARY KEY (transcription_sid, track, sequence_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_segments_call ON voice_transcript_segments(call_sid, at);
`);

  // Databases made before calls had an organisation.
  const callColumns = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(voice_calls)").all().map((column) => column.name),
  );
  if (!callColumns.has("org_id")) db.exec("ALTER TABLE voice_calls ADD COLUMN org_id TEXT");
  if (!callColumns.has("assistant_handoff")) db.exec("ALTER TABLE voice_calls ADD COLUMN assistant_handoff TEXT");
}

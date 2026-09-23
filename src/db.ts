// SQLite for the playground. The schema mirrors the ER sketch, so moving to
// Postgres later is a driver swap plus type tweaks, not a redesign.
//
// NOTE: credentials are stored as plaintext JSON here. In production this
// column holds a vault reference (KMS / Vault / SOPS), never the secret.

import { Database } from "bun:sqlite";

const FILE = process.env.DB_PATH || "data/omnichannel.sqlite";

if (FILE !== ":memory:") {
  const dir = FILE.split("/").slice(0, -1).join("/");
  if (dir) await Bun.$`mkdir -p ${dir}`.quiet();
}

export const sqlite = new Database(FILE, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS organisations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Provider-level settings (the Meta app YOU own, shared by every client).
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  channel_type       TEXT NOT NULL,
  credential_source  TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  status             TEXT NOT NULL,
  credentials        TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  -- One Page / phone number / mailbox belongs to exactly one org. This is
  -- what lets an inbound webhook find its tenant.
  UNIQUE (channel_type, external_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  display_name   TEXT NOT NULL,
  primary_email  TEXT,
  primary_phone  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_identities (
  id               TEXT PRIMARY KEY,
  contact_id       TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  org_id           TEXT NOT NULL,
  channel_type     TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  verified         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, channel_type, external_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  account_id       TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  contact_id       TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_type     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  subject          TEXT,
  thread_hint      TEXT,
  assignee_id      TEXT,
  last_inbound_at  INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction            TEXT NOT NULL,
  type                 TEXT NOT NULL,
  body                 TEXT NOT NULL DEFAULT '',
  attachments          TEXT NOT NULL DEFAULT '[]',
  external_message_id  TEXT,
  sender               TEXT,
  recipient            TEXT,
  rfc_message_id       TEXT,
  references_header    TEXT,
  status               TEXT NOT NULL,
  error                TEXT,
  created_at           INTEGER NOT NULL
);

-- Short-lived, single-use Gmail OAuth state values. Keeping these server-side
-- means the callback never has to trust organisation data from the browser.
CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state       TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

-- Idempotency: platforms retry webhooks, sometimes for hours.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
  ON messages(external_message_id) WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conv_org ON conversations(org_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
`);

// Small forward-only migrations keep existing playground databases working.
// SQLite does not support ADD COLUMN IF NOT EXISTS, so inspect first.
const messageColumns = new Set(
  sqlite.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((column) => column.name),
);
for (const [name, type] of [
  ["sender", "TEXT"],
  ["recipient", "TEXT"],
  ["rfc_message_id", "TEXT"],
  ["references_header", "TEXT"],
] as const) {
  if (!messageColumns.has(name)) sqlite.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
}

export const uid = () => crypto.randomUUID();

export function getSetting(key: string): string {
  const row = sqlite.query<{ value: string }, [string]>(
    "SELECT value FROM app_settings WHERE key = ?",
  ).get(key);
  return row?.value ?? "";
}

export function setSetting(key: string, value: string) {
  sqlite.query(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = sqlite.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM app_settings",
  ).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

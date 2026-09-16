# Omnichannel Messaging — concept app

A runnable skeleton of a multi-tenant omnichannel inbox for a messaging tech
provider: one connector interface, five channels behind it, credentials managed
in a web console, and a core that never learns which platform a message
came from.

## Run

```bash
make install
make demo        # starts the server, sends sample traffic, opens the console
make help        # everything else
```

- **Console** → `http://localhost:12301/` — organisations, provider settings, channel credentials
- **Inbox** → `http://localhost:12301/inbox` — conversations, replies, new outbound threads

No credentials needed to try it. Channels seed as `pending` with dev ids, and a
signature check is skipped whenever that channel's secret is unset.

## Targets

| Target | Does |
|---|---|
| `make dev` | hot-reload server (foreground) |
| `make bg` / `stop` / `logs` / `restart` | background server control |
| `make sim` | fire sample webhooks at all 5 channels |
| `make check` | idempotency + session-window + length guards |
| `make typecheck` | `tsc --noEmit` |
| `make db-dump` / `db-shell` / `db-reset` | inspect or wipe SQLite |
| `make tunnel` | ngrok HTTPS tunnel so platforms can reach your webhooks |
| `make tunnel-url` | print the public URL of a running tunnel |
| `make tunnel-cf` | fallback: cloudflared quick tunnel |
| `make env` | create `.env` from `.env.example` |

Port comes from `.env`, overridable anywhere: `make dev PORT=4000`.

## Gmail proof of concept

The Inbox can connect one Gmail mailbox per organisation, import the latest 20
messages carrying the `INBOX` label, preview received images, download
attachments, send email with attachments, and reply in the same Gmail thread. It uses only
`gmail.readonly` and `gmail.send`; there are no drafts, labels, webhooks, or
background synchronization.

### Google Cloud setup

1. Create or select a Google Cloud project and enable the **Gmail API**.
2. Configure the OAuth consent screen. While the app is in testing, add the
   Gmail addresses you will use under **Test users**.
3. Create an OAuth 2.0 Client ID with application type **Web application**.
4. Add the exact callback URL as an authorized redirect URI. For the default
   local setup this is
   `http://localhost:12301/api/integrations/gmail/callback`.
5. Open this app's **Settings** page and save the Google OAuth Client ID, Client
   Secret, and the same Redirect URI. These can alternatively come from
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and
   `GOOGLE_OAUTH_REDIRECT_URI`.

The redirect URI is an exact-match value: scheme, host, port, path, and trailing
slash all matter. Use the public HTTPS callback URL instead when testing through
a tunnel.

### Test receiving

1. Start the app and open `/inbox`.
2. Select the target organisation and click **Connect Gmail**.
3. Grant access at Google; the callback returns to the Inbox and performs the
   initial sync.
4. Send an email from a different account to the connected address.
5. Click **Sync Gmail**, open the conversation, and confirm the sender,
   recipient, subject, body, received time, Gmail message ID, and thread ID.
6. For a message containing an attachment, click its file chip and confirm the
   original file downloads correctly.

### Test sending

1. In `/inbox`, click **Compose email**.
2. Enter another test address, `Gmail Integration Test`, and
   `Hello from Omnichannel`, then optionally select one or more files.
3. Click **Send** and confirm it appears in the Omnichannel conversation and in
   the recipient's mailbox. The normal reply box also sends a threaded Gmail
   reply for imported messages.

For this POC, sync is manual (and runs once after OAuth), the email body is
plain text, attachments are limited to 10 MB each and 20 MB total, credentials
are plaintext in the local SQLite file, and there is no app authentication or
multi-Gmail-account support.

**Set `NGROK_DOMAIN` in `.env`** to a free static domain from
[dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains). Without it
the public URL changes on every restart, and every change means re-pasting the
callback URL into the Meta dashboard — which is a reliable source of silent
webhook failures.

## Layout

```
src/
  types.ts            ChannelConnector interface + shared vocabulary
  db.ts               SQLite schema (organisations → channels → conversations)
  store.ts            repositories over SQLite
  settings.ts         provider-level settings (your Meta app)
  seed.ts             first-boot demo org, carries over anything in .env
  core.ts             ingest pipeline, outbound guards, new conversations
  registry.ts         channel -> connector
  connectors/
    meta.ts           Messenger + Instagram + WhatsApp (one Meta app)
    line.ts           LINE Messaging API
    email.ts          provider-neutral inbound webhook + outbound HTTP API
  integrations/
    gmail.ts          OAuth, token refresh, Inbox import, and Gmail API sending
  web/
    index.html        console: organisations, secrets, collapsible channel setup
    inbox.html        agent inbox: org switcher, replies, new conversations
```

## Two levels of credentials

This split mirrors the business model:

- **Provider settings** (`app_settings` table) — the Meta and Google apps **you**
  own as the tech provider. Shared by every client.
- **Channel accounts** (`channel_accounts` table) — what each **client** owns:
  Page tokens, WhatsApp phone number ids, LINE channel secrets, mailboxes.

Both are edited in the console. Secrets are never sent back to the browser —
the UI only learns whether a value is set, and submitting a blank secret leaves
the stored one untouched.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | console |
| `GET /inbox` | agent inbox |
| `GET/POST /webhooks/meta` | Messenger, Instagram, WhatsApp (branches on `payload.object`) |
| `POST /webhooks/line` | LINE |
| `POST /webhooks/email` | inbound email from Postmark/SendGrid/SES |
| `GET/POST /api/orgs`, `PATCH/DELETE /api/orgs/:id` | organisations |
| `GET/POST /api/settings` | provider settings |
| `GET/POST /api/channels`, `DELETE /api/channels/:id` | channel accounts |
| `GET /api/integrations/gmail/connect`, `GET /api/integrations/gmail/callback` | Gmail OAuth flow |
| `GET /api/integrations/gmail/status`, `GET /api/integrations/gmail/messages` | connection status and manual inbox sync |
| `POST /api/integrations/gmail/send` | send a new email through the connected Gmail account |
| `GET /api/integrations/gmail/attachments/:messageId/:attachmentId` | download an attachment from Gmail |
| `GET /api/conversations?org=` | inbox data |
| `POST /api/conversations` | start an outbound conversation |
| `POST /api/conversations/:id/reply` | reply, subject to capability guards |

## What it demonstrates

- **One interface, many channels.** `ChannelConnector` in `types.ts` is the only
  contract. Adding WeChat means writing one file.
- **Capabilities over conditionals.** `capabilities()` drives the WhatsApp 24h
  window, length limits, and template availability. `credentialFields()` drives
  the settings forms — no per-channel HTML.
- **Tenant routing.** A webhook finds its organisation through
  `UNIQUE (channel_type, external_id)`: one Page or phone number belongs to
  exactly one org. Signature verification then uses *that org's* secret.
- **Idempotency.** A unique index on `external_message_id` makes replayed
  webhooks harmless.
- **Fast ack.** Webhooks verify, hand off, return 200. Parse failures still
  return 200, or the platform retries for hours.
- **Honest outbound.** Messaging first on WhatsApp is refused locally with a
  reason, instead of being bounced by Meta a second later.
- **Manual identity merge.** Contacts are never auto-merged across channels.

## Not built (deliberate)

Queue, websockets (the inbox polls), authentication, media download/upload,
WhatsApp templates, OAuth/Embedded Signup onboarding, delivery-status webhooks,
WeChat. Credentials are stored as plaintext JSON — in production that column
holds a vault reference.

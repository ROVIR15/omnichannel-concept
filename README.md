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

- **Console** → `http://localhost:3000/` — organisations, provider settings, channel credentials
- **Inbox** → `http://localhost:3000/inbox` — conversations, replies, new outbound threads

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
  web/
    index.html        console: organisations, secrets, collapsible channel setup
    inbox.html        agent inbox: org switcher, replies, new conversations
```

## Two levels of credentials

This split mirrors the business model:

- **Provider settings** (`app_settings` table) — the Meta app **you** own as the
  tech provider: app id, app secret, verify token. Shared by every client.
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

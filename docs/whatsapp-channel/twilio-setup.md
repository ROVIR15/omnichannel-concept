# Set up WhatsApp through Twilio

Status: Built (test-grade)
Last updated: 2026-11-10
Code: `src/whatsapp/twilio.ts`, `src/index.ts` (`/webhooks/twilio/whatsapp`)

Twilio is a second way to run the WhatsApp channel, next to Meta's Cloud API. Messages land in the same Inbox, with the same limits.

## What you need

- A Twilio account. Its **Account SID** (`AC…`) and **Auth Token** go in **Settings → Twilio**, the same ones voice uses. Every WhatsApp number uses them.
- A public URL for this app, e.g. `https://your-host` (use ngrok or similar locally)

## 1. Test fast with the Sandbox

1. Twilio Console → **Messaging → Try it out → Send a WhatsApp message**.
2. From your phone, send the join code (e.g. `join happy-tiger`) to the sandbox number, `+14155238886`.
3. Open **Sandbox settings**. Set **When a message comes in** to:
   ```
   https://your-host/webhooks/twilio/whatsapp
   ```
   Method: `POST`. Save.
4. Connect the number in the app (see step 3 below), using `+14155238886` as the id.

The sandbox only talks to phones that sent the join code.

## 2. Go live with your own number

1. Twilio Console → **Messaging → Senders → WhatsApp senders → Create new sender**.
2. Pick a Twilio number (or bring one), link your Meta Business account, and wait for approval.
3. Open the sender. Set **Webhook URL for incoming messages** to:
   ```
   https://your-host/webhooks/twilio/whatsapp
   ```
   Leave **Status callback URL** blank. We don't read delivery statuses yet.

Or skip the Console for extra numbers: use the Senders API. See [twilio-senders-api.md](twilio-senders-api.md).

## 3. Connect it in the app

Channels → add a **WhatsApp** account:

| Field | Value |
|---|---|
| Account id | The sender number in `+E.164` form, e.g. `+14155238886`. No `whatsapp:` prefix |
| Provider | `twilio` |
| WhatsApp Access Token | leave blank (that's for Meta only) |

Or by API:

```bash
curl -X POST https://your-host/api/channels \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "<org id>",
    "channelType": "whatsapp",
    "externalId": "+14155238886",
    "displayName": "Support WA (Twilio)",
    "credentials": {
      "provider": "twilio"
    }
  }'
```

## 4. Check it works

1. Send a WhatsApp message to the number. It shows in the Inbox.
2. Reply from the Inbox. It arrives on your phone.

## If something is wrong

| What you see | Why / fix |
|---|---|
| Server log: `signature rejected` | Wrong Auth Token in Settings, or the webhook URL in Twilio doesn't exactly match the public URL, including `https` and the path. Behind a proxy, it must pass `X-Forwarded-Proto` and `X-Forwarded-Host`. |
| Server log: `[core] no account for whatsapp/+…` | The account id doesn't match the `To` number. Check the `+` and that there's no `whatsapp:` prefix. |
| Reply fails: `Twilio Account SID and Auth Token are not set in Settings` | Fill them in under Settings → Twilio. |
| Reply fails with Twilio error 63016 | The customer's 24-hour window has closed. You need a template message, which isn't supported yet. |
| Reply fails: `rate limited …` | Our WhatsApp outbound limit (Settings) or Twilio's own rate limit. |

## Not supported yet

- Template messages (needed after the 24-hour window closes)
- Delivery and read status
- Sending media (receiving media works)

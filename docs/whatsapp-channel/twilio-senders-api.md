# Register WhatsApp senders with the Twilio Senders API

Status: Built (not yet tested against live Twilio)
Last updated: 2026-11-11
Code: `src/whatsapp/twilio-senders.ts`, `src/index.ts` (`/api/whatsapp/twilio/senders`), `src/web/channels.html`
Twilio docs: https://www.twilio.com/docs/whatsapp/register-senders-using-api

Add WhatsApp numbers by API, no Twilio Console clicks. Good for many clients.

## Before you start

- Twilio **Account SID** and **Auth Token** in **Settings → Twilio**.
- The **first** WhatsApp sender on the account must be made in the Console (Self Sign-up). This API only adds more.
- Number must not already be on WhatsApp. Non-Twilio numbers must get SMS or voice calls (no IVR, no outbound-only).
- Display name (`profile.name`) must follow Meta's rules. Try one sender first before bulk.
- Wait a few minutes between create calls. Twilio errors on fast bursts.

## In the app

Channels → **Connect a channel** → WhatsApp → **Register with Twilio**.

1. Fill in the number, display name, and how the code comes (SMS or voice). More profile fields are optional.
2. **Register number**. The number shows in Connected as `pending`.
3. If Meta sends a code, type it and press **Verify**. **Send code again** asks Twilio again.
4. Press **Check now** after a few minutes. When Twilio says `ONLINE`, the account becomes `active`.

The status box and code box also show inside the number's card in Connected, so you can come back later.

## How verify works

| Number | OTP by | What you do |
|---|---|---|
| Twilio, SMS | auto | nothing |
| Twilio, voice | voice → email (Voicemail Twimlet on the number) | call `/verify` with code |
| Non-Twilio, SMS | SMS to the number | call `/verify` with code |
| Non-Twilio, voice | voice call | call `/verify` with code |

For voice, send `"verificationMethod": "voice"`.

## Endpoints

All need sign-in, like the rest of `/api`.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/whatsapp/twilio/senders` | List senders (`?pageSize=&pageToken=`) |
| `POST` | `/api/whatsapp/twilio/senders` | Create sender |
| `GET` | `/api/whatsapp/twilio/senders/XE…` | Fetch one. Wait for `status: "ONLINE"` |
| `POST` | `/api/whatsapp/twilio/senders/XE…/verify` | Send OTP `{ "code": "123456" }` |
| `POST` | `/api/whatsapp/twilio/senders/XE…` | Update `profile` / `webhook` |
| `DELETE` | `/api/whatsapp/twilio/senders/XE…` | Delete sender |

### Create

```bash
curl -X POST https://your-host/api/whatsapp/twilio/senders \
  -H 'content-type: application/json' \
  -d '{
    "number": "+15017122661",
    "verificationMethod": "sms",
    "orgId": "<org id>",
    "profile": {
      "name": "Acme Support",
      "about": "Hi! We are Acme.",
      "vertical": "Other",
      "websites": ["https://acme.example"],
      "emails": ["support@acme.example"]
    }
  }'
```

- `number`: E.164. `whatsapp:` prefix and spaces are fine, we clean them.
- `webhook`: optional. Default points incoming messages at `https://<this host>/webhooks/twilio/whatsapp`.
- `orgId`: optional. If set, we also add the WhatsApp channel account (provider `twilio`) to that org. 409 if the number belongs to another org.

Returns `201 { sender, account }`. `sender.status` starts as `CREATING`.

When `orgId` is set, the channel account stays `pending` until Twilio says `ONLINE`. Fetch, verify and update all return `{ sender, account }` and copy the latest status onto the account.

### Verify, then wait

```bash
curl -X POST https://your-host/api/whatsapp/twilio/senders/XE…/verify \
  -H 'content-type: application/json' -d '{ "code": "123456" }'

curl https://your-host/api/whatsapp/twilio/senders/XE…   # repeat until ONLINE
```

`OFFLINE` right after register is normal. Check again in a few minutes.

## If something is wrong

| What you see | Fix |
|---|---|
| `Twilio Account SID and Auth Token are not set in Settings` | Fill them in. |
| Error 63110 | Number already on WhatsApp. Delete that WhatsApp account, or turn off 2FA in WhatsApp Manager. |
| No OTP | Wait. Check Twilio error logs. Create again to resend, or try voice. |
| Stuck `OFFLINE` | Check number rules, display name, WABA status in WhatsApp Manager. |
| Argentina / Mexico number fails | AR: `+549…` (drop `15`). MX: `+521…`. |

## Not supported yet

- No auto-poll to `ONLINE`. Press Check now (Twilio wants gaps between calls).
- Senders made before this feature, or in the Console, don't show the status box.
- Subaccounts: always uses the main account from Settings.

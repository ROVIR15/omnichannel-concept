# Connect a client's phone number

Status: Built (test-grade)
Last updated: 2026-10-20
Code: `src/voice/numbers.ts`, `src/voice/routes.ts`, Channels page → *Phone numbers*

## What it does

A client who already has a number in **their own Twilio account** connects it to their organisation by typing it in. The number moves into our Twilio account, and from then on:

- calls to it ring **only that organisation's** available agents
- their agents' outgoing calls show it as caller ID
- its calls and transcripts show in that organisation's Inbox

## Flow

1. **Client** (admin, Channels → Phone numbers) enters the number, e.g. `+18005550123`. It shows as **⏳ Waiting for transfer**.
2. **Client** asks Twilio Support to transfer the number to our account. The page shows our Account SID with a Copy button.
3. **Server** checks pending numbers every 5 minutes (or on *Check now*). When the number shows up in our account, it:
   - sets the number's Voice URL to the TwiML App's Voice URL (our `/webhooks/twilio/voice`)
   - sets Call status changes to `/webhooks/twilio/status`
   - clears the previous owner's fallback URL and TwiML App
   - marks it **✅ Active**

A number that is already in our account (one we bought for the client) goes active as soon as it is entered.

## Routing rules

| Call | Rings / shows |
|---|---|
| Incoming, to an active organisation number | that organisation's users whose status is *available* |
| Incoming, to the platform number (Settings → Twilio Phone Number) | everyone available, as before |
| Outgoing, agent in an organisation with an active number | caller ID = that number |
| Outgoing, otherwise (e.g. an operator) | caller ID = platform number |

## Who sees calls

| Role | Calls |
|---|---|
| Operator | all; the Inbox shows the selected organisation's plus platform-number calls |
| Admin | their organisation's |
| Agent | the calls they took |

## Notes

- The transfer itself happens at Twilio. It can take days, and a toll-free number may need its toll-free verification redone under our account. Non-US numbers need a matching Regulatory Bundle in our account first.
- *Remove* only unlinks the number from the organisation. It stays in our Twilio account, and its calls then ring everyone available, the same as the platform number.
- The webhook URL comes from the TwiML App, so set that first. If you change tunnels, update the TwiML App and the numbers.

## Not done yet

- Re-pointing active numbers when the TwiML App URL changes.
- Releasing a number from our Twilio account.
- Twilio subaccounts per client (see `user-stories.md`).

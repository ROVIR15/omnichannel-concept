# How to onboard a new phone number

Last updated: 2026-10-20

When a new organisation wants calls, first find out **where their phone number is now**. There are three situations.

| Where the number is now | What to do | How long |
|---|---|---|
| 1. Already in **our** Twilio | Assign it in the dashboard | Minutes |
| 2. In the client's **own** Twilio | Client asks Twilio to transfer it to us | Days |
| 3. With **another phone company** | Client forwards it to a Twilio number we give them | Minutes |

---

## Situation 1: The number is already in our Twilio

We bought it for the client, or it is already in our account.

1. Sign in as operator and select the client's organisation.
2. Go to **Channels → Phone numbers**.
3. Enter the number, e.g. `+18005550123`, and click **Connect number**.
4. It turns **✅ Active** right away.

---

## Situation 2: The number is in the client's own Twilio account

**What the client does:**

1. In **Channels → Phone numbers**, enter the number and click **Connect number**. It shows **⏳ Waiting for transfer**.
2. Copy our Account SID from that page.
3. Ask Twilio Support to transfer the number to that Account SID.

**What the dashboard does:**

- It checks every 5 minutes (or when someone clicks **Check now**).
- When the number arrives in our Twilio, the dashboard sets it up and marks it **✅ Active**.

**Good to know:**

- The transfer can take a few days.
- A toll-free number may need its toll-free verification done again under our account.
- A number outside the US needs a matching Regulatory Bundle in our account first.

---

## Situation 3: The number is with another phone company

The client keeps their number where it is.

1. Buy a Twilio number for the client in our account.
2. Connect that Twilio number to the client's organisation, as in **Situation 1**.
3. The client asks their phone company to **forward** their number to that Twilio number.
4. Test by calling the client's number. It should ring their agents.

**Good to know:**

- Outgoing calls show the **Twilio number**, not the client's own number. Showing their own number (Verified Caller ID) is not built yet.
- Later, the client can move the number into Twilio for good (porting). That needs a signed form and a recent phone bill, and it takes weeks.

---

## After the number is active (all situations)

1. **Create agents** for the organisation on the **Agents** page. Calls ring only that organisation's agents whose status is **available**.
2. **Test the call:** an agent opens the **Voice** page and waits for "Ready". Someone calls the number, and the agent clicks **Answer**.
3. **Check the Inbox:** the call shows with a **call** badge. If transcription is on, the transcript shows when you click it.

**If it doesn't ring:**

- No agent in the organisation has status **available**.
- The agent's Voice page isn't open or isn't "Ready".
- The number still shows **⏳ Waiting**: the transfer isn't finished.
- The ngrok address changed. Update the TwiML App's Voice URL, then re-add the number.

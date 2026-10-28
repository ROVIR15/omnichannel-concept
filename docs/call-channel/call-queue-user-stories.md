# Call Queue: User Stories

Status: Draft
Last updated: 2026-10-27

## Overview

When every agent is busy, an incoming call waits in line instead of being dropped. The longest-waiting caller goes to the next agent who is free.

### Today

`/webhooks/twilio/voice` rings every available agent of the organisation at once for 25 seconds. If no one is available, the caller hears "no one is available" and the call ends. If no one answers, the call just ends. Nothing is queued and nothing is recorded as missed.

### First-release scope

- One queue per organisation (plus one for the platform number).
- Callers wait with hold music and hear their place in line.
- First in, first out: the longest wait is offered to the next free agent.
- A maximum wait. After it, the caller can leave a voicemail.
- Every wait is recorded: answered, abandoned or timed out.

Stories marked **(later)** come after the first release. Related stories in `user-stories.md`: US-13 (routing rule), US-14 (ring timeout), US-20 (agent status), US-34 (hold music), US-35 (voicemail).

### Personas

| Persona | Description |
|---|---|
| Customer | The person calling the business |
| Agent | Team member who takes calls in the browser |
| Business admin | Sets up calls for their organisation |
| System | Automated platform behavior |

---

## 1. Customer (waiting in line)

| ID | Story | Release |
|---|---|---|
| Q-01 | As a customer, when every agent is busy, I want to wait in line with hold music instead of being cut off, so I still reach someone. | First |
| Q-02 | As a customer, I want to hear my place in line when I join and every minute after, so I know how long I may wait. | First |
| Q-03 | As a customer, when I've waited too long, I want to leave a voicemail, so the business can call me back. | First |
| Q-04 | As a customer, I want to press a key to ask for a callback and hang up, so I don't have to hold. | Later |

## 2. Agent (taking calls from the line)

| ID | Story | Release |
|---|---|---|
| Q-05 | As an agent, when I'm available, I want the longest-waiting caller of my organisation to ring in my browser, so callers are served in order. | First |
| Q-06 | As an agent, I want to see who is waiting and for how long, so I know how busy we are. | First |
| Q-07 | As an agent, when I finish a call, I want the next waiting caller to ring me, so the line keeps moving without me doing anything. | First |
| Q-08 | As an agent, I want to pick a specific caller from the line, so I can take a VIP or a call-back first. | Later |

## 3. Business admin (queue settings)

| ID | Story | Release |
|---|---|---|
| Q-09 | As a business admin, I want to set the maximum wait (default 5 minutes), so no caller holds forever. | First |
| Q-10 | As a business admin, I want to set the maximum callers in line (default 10), so extra callers go straight to voicemail. | First |
| Q-11 | As a business admin, I want to choose the hold music or upload my own, so the wait sounds like my business. | Later |
| Q-12 | As a business admin, I want to see queue numbers (waiting now, average wait, callers who hung up), so I know when to add agents. | Later |

## 4. System

| ID | Story | Release |
|---|---|---|
| Q-13 | As the system, I want each organisation to have its own line, so one business's callers never reach another business's agents. | First |
| Q-14 | As the system, I want to record each wait (joined, left, outcome: answered, hung up, timed out, line full), so missed calls show up and can be counted. | First |
| Q-15 | As the system, when a caller hangs up while waiting, I want them removed from the line and marked as a missed call, so agents can call back. | First |
| Q-16 | As the system, when the wait is long, I want the AI assistant to offer help while the caller waits, and keep their place in line, so simple questions get answered sooner. Depends on `feat/voice-ai-agent`. | Later |

---

## Decisions

- **Agent busy state:** an agent on a call, or being rung, is busy automatically. We ask Twilio for live call legs to `client:<id>`, so nothing can drift. Their own status (available, busy, away) still counts too.
- **Twilio queue or our own:** both. Twilio `<Enqueue>` holds the caller and plays music. Our table keeps the order, so a caller whose agent doesn't answer goes back in at the same place.
- **Where it lives:** `src/voice/queue.ts`, an add-on of the voice package, turned on with the `queue` option of `initVoice()`. Every incoming call goes through `routeCall()`: assistant → free agents → line → voicemail.

## Testing

1. **Fake Twilio** (done): `bun test src/voice` covers Q-01 to Q-03, Q-05, Q-07, Q-09, Q-10, Q-13 to Q-15.
2. **Real Twilio, a few people:** 2 agents in 2 browser windows, 2–3 phones. Set *Line: Longest Wait* to 60 to test timeouts quickly.
3. **Many callers:** a script starts 10–12 calls from a second Twilio number, to check the line fills up and keeps its order.

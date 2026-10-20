# Call Channel: User Stories

Status: Draft
Last updated: 2026-09-30

## Overview

The call channel lets a business make and receive phone calls from the omnichannel platform. The business adds a phone number, and we, as their tech provider, use Twilio to run the calls.

### First-release scope

- **Getting a number:** buy a new Twilio number, or use an existing number through Verified Caller ID (for outbound) plus call forwarding (for inbound).
- **Answering calls:** an agent answers in the browser (Twilio Voice JS SDK), with voicemail as the fallback.
- **Tenant setup:** each business gets its own Twilio subaccount.

Stories marked **(later)** are planned for after the first release.

### Personas

| Persona | Description |
|---|---|
| Business admin | Owner or manager who sets up and configures the channel |
| Agent | Team member who handles calls |
| Customer | The person calling or being called by the business |
| System | Automated platform behavior |
| Platform operator | Us, as the tech provider |

---

## 1. Setting up the number (business admin)

| ID | Story | Release |
|---|---|---|
| US-01 | As a business admin, I want to connect a call channel from the Channels page, so my team can make and receive calls from the platform. | First |
| US-02 | As a business admin, I want to buy a new local number by picking a country and area code, so I can start taking calls right away. | First |
| US-03 | As a business admin, I want to verify my existing number with a code sent by phone call, so outbound calls show my familiar number. | First |
| US-04 | As a business admin, I want clear steps for forwarding my existing number to the platform, so incoming calls reach my team without changing my number. | First |
| US-05 | As a business admin, I want to upload the business documents my country requires, so my number can be activated legally. | First |
| US-06 | As a business admin, I want to see my number's status (pending, active, rejected), so I know when I can start using it. | First |
| US-07 | As a business admin, I want to set a caller name for my business, so customers recognize us and calls don't get flagged as spam. | First |
| US-08 | As a business admin, I want to port my existing number to the platform, so everything runs in one place. | Later |
| US-09 | As a business admin, I want to disconnect or release a number, so I stop paying for numbers I don't use. | First |

## 2. Call settings (business admin)

| ID | Story | Release |
|---|---|---|
| US-10 | As a business admin, I want to set business hours, so calls outside those hours go straight to voicemail or a message. | First |
| US-11 | As a business admin, I want to record a greeting or use text-to-speech, so callers hear a professional welcome. | First |
| US-12 | As a business admin, I want to choose which agents or teams receive calls, so calls reach the right people. | First |
| US-13 | As a business admin, I want to choose a routing rule (ring all agents at once, or one at a time in turn), so the call load is spread fairly. | First |
| US-14 | As a business admin, I want to set how long a call rings before going to voicemail, so callers don't wait forever. | First |
| US-15 | As a business admin, I want to turn call recording on or off with an automatic consent notice, so I meet the rules in my country. | First |
| US-16 | As a business admin, I want a phone menu ("press 1 for sales"), so callers pick the right department. | Later |
| US-17 | As a business admin, I want an AI voice agent to answer first and hand over to a person, so simple questions don't need an agent. | Later |

## 3. Receiving calls (agent)

| ID | Story | Release |
|---|---|---|
| US-18 | As an agent, I want incoming calls to ring in my browser with the caller's name and history, so I have context before I pick up. | First |
| US-19 | As an agent, I want to accept or decline a call, so I only take calls when I'm available. | First |
| US-20 | As an agent, I want to set my status (available, busy, away), so calls don't ring when I can't answer. | First |
| US-21 | As an agent, I want mute, hold and hang-up buttons during a call, so I can manage the conversation. | First |
| US-22 | As an agent, I want to transfer a call to another agent, so the customer reaches the right person. | First |
| US-23 | As an agent, I want to take notes during a call that are saved to the conversation, so my team knows what was discussed. | First |

## 4. Making calls (agent)

| ID | Story | Release |
|---|---|---|
| US-24 | As an agent, I want to call a contact from their profile or conversation with one click, so I don't have to dial manually. | First |
| US-25 | As an agent, I want to dial any number with a keypad, so I can call customers who aren't in my contacts yet. | First |
| US-26 | As an agent, I want outbound calls to show the business number, so customers recognize who is calling. | First |
| US-27 | As an agent, I want to use the keypad during a call, so I can get through other companies' phone menus. | First |

## 5. After the call (agent)

| ID | Story | Release |
|---|---|---|
| US-28 | As an agent, I want each call to appear in the customer's conversation timeline next to WhatsApp and email messages, so I see the full history in one place. | First |
| US-29 | As an agent, I want to replay call recordings, so I can check what was said. | First |
| US-30 | As an agent, I want an automatic transcript and summary of each call, so I don't have to listen to the whole recording. | First |
| US-31 | As an agent, I want missed calls and voicemails to show up in my inbox as items to handle, so no customer gets forgotten. | First |
| US-32 | As an agent, I want to reply to a missed call by WhatsApp or SMS with one click, so I can follow up on the customer's preferred channel. | First |

## 6. Customer (the person calling)

| ID | Story | Release |
|---|---|---|
| US-33 | As a customer, I want to call the business's usual number and reach someone, so I don't need to learn a new number. | First |
| US-34 | As a customer, I want to hear a greeting and hold music while I wait, so I know my call is being handled. | First |
| US-35 | As a customer, I want to leave a voicemail when nobody is available, so the business can get back to me. | First |
| US-36 | As a customer, I want to be told if the call is recorded, so I can decide whether to continue. | First |

## 7. Contacts and data (system)

| ID | Story | Release |
|---|---|---|
| US-37 | As the system, I want to match a caller's number to an existing contact, including their WhatsApp contact, so every channel shares one customer profile. | First |
| US-38 | As an agent, I want a new contact created automatically for an unknown caller, so I can add details later. | First |

## 8. Billing and reporting (business admin)

| ID | Story | Release |
|---|---|---|
| US-39 | As a business admin, I want to see call minutes and costs for each billing period, so I can control spending. | First |
| US-40 | As a business admin, I want a spending limit or prepaid balance with low-balance alerts, so I never get surprise bills. | First |
| US-41 | As a business admin, I want call reports (volume, missed-call rate, average wait time, calls per agent), so I can measure team performance. | Later |

## 9. Platform (tech provider)

| ID | Story | Release |
|---|---|---|
| US-42 | As the platform operator, I want each business on its own Twilio subaccount, so usage, billing and problems stay separate for each business. | First |
| US-43 | As the platform operator, I want to suspend a business's calling, so I can stop abuse or unpaid usage quickly. | First |
| US-44 | As the platform operator, I want to track each business's Twilio costs against what we charge them, so I know our margin. | First |

## 10. Twilio configuration (settings page)

### Platform settings (platform operator)

| ID | Story | Release |
|---|---|---|
| US-45 | As the platform operator, I want to enter our main Twilio Account SID and Auth Token on the settings page, so the platform can create subaccounts and manage numbers. | First |
| US-46 | As the platform operator, I want to test the Twilio connection with one click, so I know the credentials work before businesses start using calls. | First |
| US-47 | As the platform operator, I want secrets masked after saving and stored encrypted, so they can't be read from the screen or the database. | First |
| US-48 | As the platform operator, I want to rotate the Auth Token and API keys without downtime, so a leaked key can be replaced safely. | First |
| US-49 | As the platform operator, I want the webhook URLs (voice, status callback, recording callback) shown with a copy button, so I can check them against the Twilio console. | First |
| US-50 | As the platform operator, I want the platform to create the TwiML App and API keys automatically when I save credentials, so I don't have to set them up by hand in Twilio. | First |
| US-51 | As the platform operator, I want to set default call options (recording on or off, transcription language, maximum call length, allowed countries for outbound calls), so every new business starts with safe settings. | First |
| US-52 | As the platform operator, I want to see each business's subaccount status (active, suspended, closed) on the settings page, so I can manage tenants in one place. | First |

### Business settings (business admin)

| ID | Story | Release |
|---|---|---|
| US-53 | As a business admin, I want a Calls section on my settings page showing my numbers, their status and their registration status, so I can see my setup at a glance. | First |
| US-54 | As a business admin, I want to manage call settings (hours, greeting, routing, ring timeout, recording) from the Calls section, so everything about calls is in one place. | First |
| US-55 | As a business admin, I want to connect my own Twilio account instead of using the platform's, so I can keep my existing numbers and my own Twilio billing. | Later |

### Settings page fields

**Platform settings (operator only)**

| Field | Type | Notes |
|---|---|---|
| Account SID | Text | Starts with `AC` |
| Auth Token | Secret | Masked after saving; encrypted at rest |
| API Key SID / Secret | Secret | Created automatically; used to issue browser tokens for agents |
| TwiML App SID | Read-only | Created automatically; links browser calls to our voice webhook |
| Voice webhook URL | Read-only, copyable | Handles incoming calls |
| Status callback URL | Read-only, copyable | Receives call status updates |
| Recording callback URL | Read-only, copyable | Receives recordings when they are ready |
| Default recording | Toggle | Default for new businesses |
| Transcription language | Select | Default for new businesses |
| Maximum call length | Number (minutes) | Stops very long or stuck calls |
| Allowed outbound countries | Multi-select | Blocks expensive destinations and toll fraud |
| Connection status | Indicator | Shows the result of the last connection test |

**Business settings (Calls section)**

| Field | Type | Notes |
|---|---|---|
| Phone numbers | List | Number, source (bought, verified, forwarded), status |
| Registration | Status plus upload | Business documents required by the country |
| Caller name | Text | Name customers see on outbound calls, where supported |
| Business hours | Schedule | Includes time zone |
| Greeting | Audio upload or text-to-speech | |
| Routing | Agents or teams plus rule | Ring all at once, or one at a time in turn |
| Ring timeout | Number (seconds) | Time before voicemail |
| Recording | Toggle | Plays a consent notice when on |
| Spending limit | Amount | Sends low-balance alerts |

---

## Open questions

1. Which countries are the businesses in? This decides whether Twilio local numbers are available, and what registration documents are required.
2. Is the main use inbound support, outbound sales, or both?
3. Should a person in the browser answer first, or an AI voice agent?
4. Cost model: pass Twilio costs through, include minutes in a plan, or use a prepaid wallet?
5. Should WhatsApp Business Calling be offered alongside regular phone calls?
6. Should businesses be able to connect their own Twilio account (US-55), or only use the platform's subaccounts?
7. Do we need separate Twilio credentials for staging and production on the settings page?

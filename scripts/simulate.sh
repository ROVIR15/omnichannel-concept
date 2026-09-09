#!/usr/bin/env bash
# Fire realistic webhook payloads at a locally running server.
# Works with no credentials: signature checks skip when secrets are unset.
set -e
BASE="${BASE:-http://localhost:3000}"

# Pick up credentials the same way the server does, so signed webhooks and
# the email secret line up.
if [ -f .env ]; then set -a; . ./.env; set +a; fi

post() { curl -s -o /dev/null -w "%{http_code} $1\n" -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"; }

post /webhooks/meta '{
  "object":"page",
  "entry":[{"id":"'"${MESSENGER_PAGE_ID:-PAGE_1}"'","messaging":[
    {"sender":{"id":"psid-1001"},"timestamp":1735689600000,
     "message":{"mid":"mid.msgr.1","text":"Hi, is my order shipped?"}}]}]}'

post /webhooks/meta '{
  "object":"instagram",
  "entry":[{"id":"'"${INSTAGRAM_ACCOUNT_ID:-IG_1}"'","messaging":[
    {"sender":{"id":"ig-2002"},"timestamp":1735689700000,
     "message":{"mid":"mid.ig.1","text":"Do you ship to Bandung?"}}]}]}'

post /webhooks/meta '{
  "object":"whatsapp_business_account",
  "entry":[{"id":"WABA_1","changes":[{"field":"messages","value":{
    "metadata":{"phone_number_id":"'"${WHATSAPP_PHONE_NUMBER_ID:-WA_1}"'"},
    "contacts":[{"profile":{"name":"Rina"},"wa_id":"628123456789"}],
    "messages":[{"from":"628123456789","id":"wamid.1","timestamp":"1735689800",
                 "type":"text","text":{"body":"Halo, mau tanya harga"}}]}}]}]}'

post /webhooks/line '{
  "destination":"'"${LINE_CHANNEL_ID:-line-default}"'",
  "events":[{"type":"message","timestamp":1735689900000,
    "source":{"type":"user","userId":"U-line-3003"},
    "replyToken":"rt-abc",
    "message":{"id":"line-msg-1","type":"text","text":"Store hours today?"}}]}'

post "/webhooks/email?secret=${EMAIL_INBOUND_SECRET:-}" '{
  "from":"customer@example.com","fromName":"Budi",
  "to":"'"${EMAIL_ADDRESS:-support@example.com}"'",
  "subject":"Invoice question","messageId":"<abc123@mail>",
  "text":"Could you resend invoice #4471?"}'

echo
echo "Inbox → $BASE/"

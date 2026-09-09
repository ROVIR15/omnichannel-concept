// Guard checks: idempotency, the session window, and length caps.
import { ingest, checkSendable } from "../src/core";
import { setLastInboundAt, listOrgs, listConversations } from "../src/store";
import { whatsappConnector } from "../src/connectors/meta";
import { seedIfEmpty } from "../src/seed";

seedIfEmpty();
const org = listOrgs()[0]!;

const payload = JSON.stringify({object:"whatsapp_business_account",entry:[{id:"WABA_1",changes:[{field:"messages",value:{
  metadata:{phone_number_id:"WA_1"},contacts:[{profile:{name:"Rina"}}],
  messages:[{from:"628999000111",id:"wamid.guardtest",timestamp:"1735689800",type:"text",text:{body:"hi"}}]}}]}]});

console.log("ingest  :", JSON.stringify(ingest(whatsappConnector.parseInbound(payload))));
console.log("replay  :", JSON.stringify(ingest(whatsappConnector.parseInbound(payload))), "(must be a duplicate)");

const conv = listConversations(org.id).find(c => c.channel_type === "whatsapp")!;
console.log("fresh   :", checkSendable(conv.id, "hello").ok);

setLastInboundAt(conv.id, Date.now() - 25 * 3600_000);
console.log("stale   :", JSON.stringify(checkSendable(conv.id, "hello")));
console.log("toolong :", JSON.stringify(checkSendable(conv.id, "x".repeat(5000))));

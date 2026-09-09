// First-boot seeding. Creates a demo organisation, and carries over anything
// already sitting in .env so existing setups keep working after the move
// to database-stored credentials.

import { listOrgs, createOrg, listAccounts, upsertAccount } from "./store";
import { saveAppSettings } from "./settings";
import type { ChannelAccount, ChannelType, CredentialSource } from "./types";

const env = (k: string) => process.env[k] ?? "";

export function seedIfEmpty() {
  if (listOrgs().length > 0) return;

  const org = createOrg("Demo Organisation");
  console.log(`[seed] created organisation "${org.name}"`);

  saveAppSettings({
    meta_app_id: env("META_APP_ID"),
    meta_app_secret: env("META_APP_SECRET"),
    meta_verify_token: env("META_VERIFY_TOKEN"),
    meta_graph_version: env("META_GRAPH_VERSION") || "v21.0",
  });

  const defs: Array<{
    channelType: ChannelType; source: CredentialSource;
    externalId: string; devId: string; name: string; credentials: Record<string, string>;
  }> = [
    { channelType: "messenger", source: "oauth_via_us", externalId: env("MESSENGER_PAGE_ID"), devId: "PAGE_1", name: "Facebook Page", credentials: { pageToken: env("MESSENGER_PAGE_TOKEN") } },
    { channelType: "instagram", source: "oauth_via_us", externalId: env("INSTAGRAM_ACCOUNT_ID"), devId: "IG_1", name: "Instagram Direct", credentials: { pageToken: env("INSTAGRAM_PAGE_TOKEN") } },
    { channelType: "whatsapp",  source: "oauth_via_us", externalId: env("WHATSAPP_PHONE_NUMBER_ID"), devId: "WA_1", name: "WhatsApp Business", credentials: { token: env("WHATSAPP_TOKEN") } },
    { channelType: "line",      source: "byo_keys",     externalId: env("LINE_CHANNEL_ID"), devId: "line-default", name: "LINE Official Account", credentials: { channelSecret: env("LINE_CHANNEL_SECRET"), accessToken: env("LINE_ACCESS_TOKEN") } },
    { channelType: "email",     source: "byo_keys",     externalId: env("EMAIL_ADDRESS"), devId: "support@example.com", name: "Support Mailbox", credentials: { inboundSecret: env("EMAIL_INBOUND_SECRET"), apiUrl: env("EMAIL_API_URL"), apiToken: env("EMAIL_API_TOKEN") } },
  ];

  for (const d of defs) {
    const account: Omit<ChannelAccount, "id"> = {
      orgId: org.id,
      channelType: d.channelType,
      credentialSource: d.source,
      externalId: d.externalId || d.devId,
      displayName: d.name,
      status: "pending",
      credentials: Object.fromEntries(Object.entries(d.credentials).filter(([, v]) => v)),
    };
    upsertAccount(account);
  }

  console.log(`[seed] created ${listAccounts(org.id).length} channel accounts`);
}

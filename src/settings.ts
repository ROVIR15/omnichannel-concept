// Provider-level settings: the Meta app YOU own as the tech provider, shared
// by every client organisation. Stored in the DB, editable from the console.
// Env vars remain a fallback so existing .env setups keep working.

import { allSettings, getSetting, setSetting } from "./db";
import type { CredentialField } from "./types";
import { WHATSAPP_LIMIT_DEFAULTS as WA } from "./whatsapp/defaults";

export const APP_SETTING_FIELDS: CredentialField[] = [
  { key: "meta_app_id", label: "Meta App ID", secret: false, help: "App Dashboard → Settings → Basic" },
  { key: "meta_app_secret", label: "Meta App Secret", secret: true, help: "Signs every Meta webhook. Blank = signature check skipped." },
  { key: "meta_verify_token", label: "Meta Verify Token", secret: true, help: "Any random string — must match what you type into Meta's webhook form." },
  { key: "meta_login_config_id", label: "Facebook Login Config ID", secret: false, help: "Facebook Login for Business → Configurations. Blank = classic scopes are requested instead." },
  { key: "meta_oauth_redirect_uri", label: "Facebook OAuth Redirect URI", secret: false, help: "Must be HTTPS and listed under Valid OAuth Redirect URIs, e.g. https://<tunnel>/api/integrations/facebook/callback. Blank = derived from the request." },
  { key: "meta_graph_version", label: "Graph API Version", secret: false, help: "e.g. v21.0" },
  { key: "meta_test_access_token", label: "Graph API Test Access Token", secret: false, help: "Used by the Permissions test page to call the Graph API directly from the browser. A manual testing token, not a client credential — do not use a long-lived production token here." },
  { key: "instagram_app_secret", label: "Instagram App Secret", secret: true, help: "Only if Instagram webhooks are signed separately — App Dashboard → Instagram → API setup." },
  { key: "google_oauth_client_id", label: "Google OAuth Client ID", secret: false, help: "Google Cloud → APIs & Services → Credentials" },
  { key: "google_oauth_client_secret", label: "Google OAuth Client Secret", secret: true, help: "Stored server-side and never returned to the browser." },
  { key: "google_oauth_redirect_uri", label: "Google OAuth Redirect URI", secret: false, help: "Must exactly match Google Cloud, e.g. https://your-host/api/integrations/gmail/callback" },
  { key: "microsoft_oauth_client_id", label: "Microsoft Application (client) ID", secret: false, help: "Microsoft Entra admin center → App registrations → Overview" },
  { key: "microsoft_oauth_client_secret", label: "Microsoft Client Secret", secret: true, help: "App registrations → Certificates & secrets. Store the secret value, not its ID." },
  { key: "microsoft_oauth_redirect_uri", label: "Microsoft OAuth Redirect URI", secret: false, help: "Must exactly match the Web redirect URI, e.g. http://localhost:12301/api/integrations/outlook/callback" },
  // WhatsApp totals: "<count>/<seconds>", 0 = unlimited, blank = default.
  // Daily: a plain count per calendar day, blank or 0 = unlimited.
  { key: "whatsapp_inbound_limit", label: "Inbound messages", secret: false, placeholder: WA.whatsapp_inbound_limit, help: `Total WhatsApp messages accepted from customers, across all numbers. Extra messages are dropped. Default ${WA.whatsapp_inbound_limit}.` },
  { key: "whatsapp_inbound_daily_limit", label: "Inbound messages per day", secret: false, placeholder: "unlimited", help: "Total WhatsApp messages accepted per calendar day, resetting at midnight server time. Applies on top of the limit above." },
  { key: "whatsapp_outbound_limit", label: "Outbound messages", secret: false, placeholder: WA.whatsapp_outbound_limit, help: `Total WhatsApp messages sent, across all numbers. Extra sends fail with a retry time. Default ${WA.whatsapp_outbound_limit}.` },
  { key: "whatsapp_outbound_daily_limit", label: "Outbound messages per day", secret: false, placeholder: "unlimited", help: "Total WhatsApp messages sent per calendar day, resetting at midnight server time. Applies on top of the limit above." },
];

const ENV_FALLBACK: Record<string, string> = {
  meta_app_id: "META_APP_ID",
  meta_app_secret: "META_APP_SECRET",
  meta_verify_token: "META_VERIFY_TOKEN",
  meta_login_config_id: "META_LOGIN_CONFIG_ID",
  meta_oauth_redirect_uri: "META_OAUTH_REDIRECT_URI",
  meta_graph_version: "META_GRAPH_VERSION",
  instagram_app_secret: "INSTAGRAM_APP_SECRET",
  google_oauth_client_id: "GOOGLE_OAUTH_CLIENT_ID",
  google_oauth_client_secret: "GOOGLE_OAUTH_CLIENT_SECRET",
  google_oauth_redirect_uri: "GOOGLE_OAUTH_REDIRECT_URI",
  microsoft_oauth_client_id: "MICROSOFT_OAUTH_CLIENT_ID",
  microsoft_oauth_client_secret: "MICROSOFT_OAUTH_CLIENT_SECRET",
  microsoft_oauth_redirect_uri: "MICROSOFT_OAUTH_REDIRECT_URI",
  whatsapp_inbound_limit: "WHATSAPP_INBOUND_LIMIT",
  whatsapp_outbound_limit: "WHATSAPP_OUTBOUND_LIMIT",
  whatsapp_inbound_daily_limit: "WHATSAPP_INBOUND_DAILY_LIMIT",
  whatsapp_outbound_daily_limit: "WHATSAPP_OUTBOUND_DAILY_LIMIT",
};

export function appSetting(key: string): string {
  return getSetting(key) || process.env[ENV_FALLBACK[key] ?? ""] || "";
}

export function saveAppSettings(patch: Record<string, string>) {
  for (const f of APP_SETTING_FIELDS) {
    if (typeof patch[f.key] === "string") setSetting(f.key, patch[f.key]!);
  }
}

/** Secrets are never sent to the browser — only whether they are set. */
export function maskedAppSettings() {
  const stored = allSettings();
  return APP_SETTING_FIELDS.map((f) => ({
    ...f,
    value: f.secret ? "" : (stored[f.key] ?? process.env[ENV_FALLBACK[f.key] ?? ""] ?? ""),
    configured: Boolean(appSetting(f.key)),
    fromEnv: !stored[f.key] && Boolean(process.env[ENV_FALLBACK[f.key] ?? ""]),
  }));
}

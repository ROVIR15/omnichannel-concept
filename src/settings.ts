// Provider-level settings: the Meta app YOU own as the tech provider, shared
// by every client organisation. Stored in the DB, editable from the console.
// Env vars remain a fallback so existing .env setups keep working.

import { allSettings, getSetting, setSetting } from "./db";
import type { CredentialField } from "./types";

export const APP_SETTING_FIELDS: CredentialField[] = [
  { key: "meta_app_id", label: "Meta App ID", secret: false, help: "App Dashboard → Settings → Basic" },
  { key: "meta_app_secret", label: "Meta App Secret", secret: true, help: "Signs every Meta webhook. Blank = signature check skipped." },
  { key: "meta_verify_token", label: "Meta Verify Token", secret: true, help: "Any random string — must match what you type into Meta's webhook form." },
  { key: "meta_graph_version", label: "Graph API Version", secret: false, help: "e.g. v21.0" },
  { key: "instagram_app_secret", label: "Instagram App Secret", secret: true, help: "Only if Instagram webhooks are signed separately — App Dashboard → Instagram → API setup." },
  { key: "google_oauth_client_id", label: "Google OAuth Client ID", secret: false, help: "Google Cloud → APIs & Services → Credentials" },
  { key: "google_oauth_client_secret", label: "Google OAuth Client Secret", secret: true, help: "Stored server-side and never returned to the browser." },
  { key: "google_oauth_redirect_uri", label: "Google OAuth Redirect URI", secret: false, help: "Must exactly match Google Cloud, e.g. https://your-host/api/integrations/gmail/callback" },
];

const ENV_FALLBACK: Record<string, string> = {
  meta_app_id: "META_APP_ID",
  meta_app_secret: "META_APP_SECRET",
  meta_verify_token: "META_VERIFY_TOKEN",
  meta_graph_version: "META_GRAPH_VERSION",
  instagram_app_secret: "INSTAGRAM_APP_SECRET",
  google_oauth_client_id: "GOOGLE_OAUTH_CLIENT_ID",
  google_oauth_client_secret: "GOOGLE_OAUTH_CLIENT_SECRET",
  google_oauth_redirect_uri: "GOOGLE_OAUTH_REDIRECT_URI",
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

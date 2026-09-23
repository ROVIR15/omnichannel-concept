// Client-facing onboarding: the "Connect via us" path.
//
// Embedded Signup hands the browser a short-lived OAuth code plus the ids of
// the WhatsApp Business Account the client just granted. The server exchanges
// that code for a business token, subscribes this app to the client's WABA so
// webhooks start flowing, and stores the result as a channel account.
//
// The manual "paste your credentials" path still exists — this is the same
// destination reached without the client ever seeing an access token.

import { appSetting } from "./settings";
import { accountByExternal, upsertAccount } from "./store";
import type { ChannelAccount, ChannelType } from "./types";

const GRAPH = () => `https://graph.facebook.com/${appSetting("meta_graph_version") || "v26.0"}`;

export interface EmbeddedSignupInput {
  orgId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string;
  displayName?: string;
}

export interface ConnectResult {
  ok: boolean;
  step?: string;
  error?: string;
  account?: ChannelAccount;
}

/** Step 1: code → business access token. */
async function exchangeCode(code: string, redirectUri?: string) {
  const url = new URL(`${GRAPH()}/oauth/access_token`);
  url.searchParams.set("client_id", appSetting("meta_app_id"));
  url.searchParams.set("client_secret", appSetting("meta_app_secret"));
  url.searchParams.set("code", code);
  // The JS SDK popup has no redirect; the server redirect flow must repeat the
  // exact redirect_uri it sent to the dialog, or the exchange is rejected.
  if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);

  const res = await fetch(url);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    return { ok: false as const, error: json.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true as const, token: json.access_token as string };
}

/** Step 2: subscribe THIS app to the client's WABA, or no webhooks arrive.
 *  The equivalent of /{page-id}/subscribed_apps on the Messenger side — and
 *  the step whose absence looks like a working integration that delivers
 *  nothing. */
async function subscribeToWaba(wabaId: string, token: string) {
  const res = await fetch(`${GRAPH()}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    return { ok: false as const, error: json.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true as const };
}

/** Optional: read the number back so the account has a human-readable name. */
async function describeNumber(phoneNumberId: string, token: string) {
  const res = await fetch(
    `${GRAPH()}/${phoneNumberId}?fields=display_phone_number,verified_name`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const json: any = await res.json().catch(() => ({}));
  return res.ok ? json : null;
}

export async function completeWhatsAppSignup(input: EmbeddedSignupInput): Promise<ConnectResult> {
  if (!appSetting("meta_app_secret")) {
    return { ok: false, step: "config", error: "Meta App Secret is not set in provider settings" };
  }

  const exchanged = await exchangeCode(input.code);
  if (!exchanged.ok) return { ok: false, step: "token exchange", error: exchanged.error };

  const subscribed = await subscribeToWaba(input.wabaId, exchanged.token);
  if (!subscribed.ok) return { ok: false, step: "waba subscription", error: subscribed.error };

  const info = await describeNumber(input.phoneNumberId, exchanged.token);
  const label =
    input.displayName?.trim() ||
    (info?.verified_name ? `${info.verified_name} (${info.display_phone_number})` : "WhatsApp Business");

  const account = upsertAccount({
    orgId: input.orgId,
    channelType: "whatsapp",
    credentialSource: "oauth_via_us",
    externalId: input.phoneNumberId,
    displayName: label,
    status: "active",
    credentials: { token: exchanged.token, wabaId: input.wabaId },
  });

  return { ok: true, account };
}

// ---------------------------------------------------------------------------
// Facebook Login for Business: Messenger and Instagram.
//
// A full-page redirect, like Gmail: /connect sends the client to Facebook,
// /callback turns the code into Page tokens, and the Channels page lets the
// client pick which Page to connect. Tokens never reach the browser — the page
// list it sees is ids and names only; the tokens wait here, keyed by a random
// session id, until the client picks.
// ---------------------------------------------------------------------------

export type FacebookChannel = Extract<ChannelType, "messenger" | "instagram">;

/** Used when no Login for Business configuration is set. With a config_id,
 *  the permissions come from the configuration instead. */
const FB_SCOPES = [
  "pages_show_list", "pages_messaging", "pages_manage_metadata", "business_management",
  "instagram_basic", "instagram_manage_messages",
];

const TEN_MINUTES = 10 * 60 * 1000;

interface FacebookPage {
  id: string;
  name: string;
  token: string;
  instagram?: { id: string; username?: string };
}

interface PendingState { orgId: string; channel: FacebookChannel; redirectUri: string; expires: number }
interface PendingPages { orgId: string; channel: FacebookChannel; pages: FacebookPage[]; expires: number }

// In memory on purpose: both live minutes, and a restart only means "connect again".
const states = new Map<string, PendingState>();
const sessions = new Map<string, PendingPages>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of states) if (v.expires < now) states.delete(k);
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
}

export function facebookConfigured(): boolean {
  return Boolean(appSetting("meta_app_id") && appSetting("meta_app_secret"));
}

/** The dialog URL to send the browser to. */
export function facebookLoginUrl(orgId: string, channel: FacebookChannel, redirectUri: string): string {
  sweep();
  const state = crypto.randomUUID();
  states.set(state, { orgId, channel, redirectUri, expires: Date.now() + TEN_MINUTES });

  const version = appSetting("meta_graph_version") || "v26.0";
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set("client_id", appSetting("meta_app_id"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configId = appSetting("meta_login_config_id");
  if (configId) url.searchParams.set("config_id", configId);
  else url.searchParams.set("scope", FB_SCOPES.join(","));
  return url.toString();
}

/** Short-lived user token → long-lived one. Page tokens read with a long-lived
 *  user token do not expire; with a short-lived one they die within the hour. */
async function longLived(token: string): Promise<string> {
  const url = new URL(`${GRAPH()}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appSetting("meta_app_id"));
  url.searchParams.set("client_secret", appSetting("meta_app_secret"));
  url.searchParams.set("fb_exchange_token", token);
  const res = await fetch(url);
  const json: any = await res.json().catch(() => ({}));
  return res.ok && json.access_token ? json.access_token : token;
}

async function listPages(userToken: string) {
  const url = new URL(`${GRAPH()}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { headers: { authorization: `Bearer ${userToken}` } });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false as const, error: json.error?.message ?? `HTTP ${res.status}` };
  const pages: FacebookPage[] = (json.data ?? []).map((p: any) => ({
    id: String(p.id),
    name: p.name,
    token: p.access_token,
    instagram: p.instagram_business_account
      ? { id: String(p.instagram_business_account.id), username: p.instagram_business_account.username }
      : undefined,
  }));
  return { ok: true as const, pages };
}

export interface CallbackResult { ok: boolean; orgId?: string; channel?: FacebookChannel; session?: string; error?: string }

/** Facebook redirected back: code → long-lived user token → the client's Pages. */
export async function completeFacebookLogin(params: URLSearchParams): Promise<CallbackResult> {
  sweep();
  const pending = states.get(params.get("state") ?? "");
  if (!pending) return { ok: false, error: "Login expired or was started elsewhere — please connect again." };
  states.delete(params.get("state")!);
  const base = { orgId: pending.orgId, channel: pending.channel };

  if (params.get("error")) {
    return { ...base, ok: false, error: params.get("error_description") || "Facebook login was cancelled." };
  }
  const code = params.get("code");
  if (!code) return { ...base, ok: false, error: "Facebook did not return a code." };

  const exchanged = await exchangeCode(code, pending.redirectUri);
  if (!exchanged.ok) return { ...base, ok: false, error: `Token exchange failed: ${exchanged.error}` };

  const listed = await listPages(await longLived(exchanged.token));
  if (!listed.ok) return { ...base, ok: false, error: `Could not list Pages: ${listed.error}` };
  if (listed.pages.length === 0) {
    return { ...base, ok: false, error: "No Facebook Pages were shared. Reconnect and select at least one Page." };
  }

  const session = crypto.randomUUID();
  sessions.set(session, { ...base, pages: listed.pages, expires: Date.now() + TEN_MINUTES });
  return { ...base, ok: true, session };
}

/** What the browser may see: no tokens. */
export function facebookPages(session: string, orgId: string) {
  sweep();
  const s = sessions.get(session);
  if (!s || s.orgId !== orgId) return null;
  return {
    channel: s.channel,
    pages: s.pages.map((p) => ({
      id: p.id,
      name: p.name,
      instagram: p.instagram ?? null,
      connected: {
        messenger: accountByExternal("messenger", p.id)?.orgId === orgId,
        instagram: p.instagram ? accountByExternal("instagram", p.instagram.id)?.orgId === orgId : false,
      },
    })),
  };
}

/** Same trap as the WABA: without this, the Page never delivers webhooks. */
async function subscribePage(pageId: string, pageToken: string) {
  const url = new URL(`${GRAPH()}/${pageId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "messages,messaging_postbacks");
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${pageToken}` } });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    return { ok: false as const, error: json.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true as const };
}

export async function connectFacebookPage(input: {
  session: string; orgId: string; pageId: string; channel: FacebookChannel;
}): Promise<ConnectResult> {
  const s = sessions.get(input.session);
  if (!s || s.orgId !== input.orgId) {
    return { ok: false, step: "session", error: "Login expired — please connect with Facebook again." };
  }
  const page = s.pages.find((p) => p.id === input.pageId);
  if (!page) return { ok: false, step: "page", error: "That Page was not part of this login." };
  if (input.channel === "instagram" && !page.instagram) {
    return { ok: false, step: "page", error: `${page.name} has no Instagram professional account linked.` };
  }

  // Instagram is addressed by the IG account id inbound, but sent to via the
  // Page id — see instagramConnector.send.
  const target: { externalId: string; displayName: string; credentials: Record<string, string> } =
    input.channel === "instagram"
    ? {
        externalId: page.instagram!.id,
        displayName: page.instagram!.username ? `@${page.instagram!.username}` : `${page.name} (Instagram)`,
        credentials: { pageToken: page.token, pageId: page.id },
      }
    : { externalId: page.id, displayName: page.name, credentials: { pageToken: page.token } };

  const existing = accountByExternal(input.channel, target.externalId);
  if (existing && existing.orgId !== input.orgId) {
    return { ok: false, step: "conflict", error: `That ${input.channel} account is already connected to another organisation.` };
  }

  const subscribed = await subscribePage(page.id, page.token);
  if (!subscribed.ok) return { ok: false, step: "page subscription", error: subscribed.error };

  const account = upsertAccount({
    id: existing?.id,
    orgId: input.orgId,
    channelType: input.channel,
    credentialSource: "oauth_via_us",
    ...target,
    status: "active",
  });
  return { ok: true, account };
}

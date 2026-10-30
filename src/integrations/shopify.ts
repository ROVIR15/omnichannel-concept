// Shopify OAuth: a full-page redirect like Outlook/Gmail, scoped to the
// store the client types in rather than a fixed authorize URL — Shopify's
// dialog lives at https://{shop}.myshopify.com/admin/oauth/authorize.

import { createHmac, timingSafeEqual } from "node:crypto";
import { appSetting } from "../settings";
import {
  consumeShopifyOAuthState,
  createShopifyOAuthState,
  deleteShopifyConnection,
  getOrg,
  shopifyConnection,
  updateShopifyTokens,
  upsertShopifyConnection,
} from "../store";

export const SHOPIFY_SCOPES = [
  "read_products",
  "read_inventory",
  // Shopify's Location resource (/locations.json) — which inventory_levels
  // requires a location_id to query — is gated by this scope separately
  // from read_inventory. Without it, locations.json 403s and the inventory
  // tab never gets past the first call.
  "read_locations",
  "read_orders",
  "read_customers",
  "read_content",
  "read_legal_policies",
];

function config() {
  return {
    apiKey: appSetting("shopify_api_key"),
    apiSecret: appSetting("shopify_api_secret"),
    redirectUri: appSetting("shopify_oauth_redirect_uri"),
  };
}

function requiredConfig() {
  const values = config();
  const missing = [
    ["apiKey", values.apiKey],
    ["apiSecret", values.apiSecret],
    ["redirectUri", values.redirectUri],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Shopify OAuth is not configured (${missing.join(", ")})`);
  return values;
}

/** Accepts "my-store", "my-store.myshopify.com" or a full URL and normalizes
 *  to the bare *.myshopify.com host Shopify's OAuth endpoints expect. */
export function normalizeShopDomain(input: string): string {
  let shop = input.trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!shop.includes(".")) shop = `${shop}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error("enter a valid Shopify store domain, e.g. my-store.myshopify.com");
  }
  return shop;
}

export function shopifyConnectionStatus(orgId: string) {
  const connection = shopifyConnection(orgId);
  const values = config();
  return {
    configured: Boolean(values.apiKey && values.apiSecret && values.redirectUri),
    connected: Boolean(connection),
    shopDomain: connection?.shop_domain ?? null,
    scope: connection?.scope ?? null,
  };
}

export function shopifyConnectUrl(orgId: string, shopInput: string): string {
  if (!getOrg(orgId)) throw new Error("organisation not found");
  const shop = normalizeShopDomain(shopInput);
  const values = requiredConfig();
  const state = createShopifyOAuthState(orgId, shop);
  const params = new URLSearchParams({
    client_id: values.apiKey,
    scope: SHOPIFY_SCOPES.join(","),
    redirect_uri: values.redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

/** Shopify signs every callback query string with the app secret; a request
 *  without a valid signature did not come from Shopify. */
function verifyHmac(params: URLSearchParams, apiSecret: string): boolean {
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface AccessTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  errors?: string;
}

export async function completeShopifyOAuth(state: string, params: URLSearchParams): Promise<{
  orgId: string; shopDomain: string; scope: string;
}> {
  const pending = consumeShopifyOAuthState(state);
  if (!pending) throw new Error("invalid or expired OAuth state");

  const shop = params.get("shop") ?? "";
  if (shop !== pending.shop) throw new Error("shop did not match the store that started this connection");

  const values = requiredConfig();
  if (!verifyHmac(params, values.apiSecret)) throw new Error("Shopify callback signature did not verify");

  const code = params.get("code");
  if (!code) throw new Error("Shopify did not return an authorization code");

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: values.apiKey, client_secret: values.apiSecret, code, expiring: 1 }),
  });
  const tokens: AccessTokenResponse = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token || !tokens.refresh_token || !tokens.expires_in) {
    throw new Error(tokens.errors ?? `Shopify token exchange failed (HTTP ${response.status})`);
  }

  const connection = upsertShopifyConnection({
    orgId: pending.orgId,
    shopDomain: shop,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope ?? SHOPIFY_SCOPES.join(","),
  });
  return { orgId: pending.orgId, shopDomain: connection.shop_domain, scope: connection.scope };
}

export function disconnectShopify(orgId: string): void {
  if (!shopifyConnection(orgId)) throw new Error("Shopify is not connected for this organisation");
  deleteShopifyConnection(orgId);
}

// ---------------------------------------------------------------------------
// Admin API reads — one per granted scope. Kept to the fields the UI shows;
// Shopify's objects carry much more than this app needs.
// ---------------------------------------------------------------------------

const API_VERSION = "2024-10";

async function freshShopifyConnection(orgId: string) {
  const connection = shopifyConnection(orgId);
  if (!connection) throw new Error("Shopify is not connected for this organisation");
  if (connection.expires_at && connection.expires_at > Date.now() + 60_000) return connection;
  if (!connection.refresh_token) throw new Error("Shopify must be reconnected to issue an expiring offline token");

  const values = requiredConfig();
  const response = await fetch(`https://${connection.shop_domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: values.apiKey,
      client_secret: values.apiSecret,
      refresh_token: connection.refresh_token,
    }),
  });
  const tokens: AccessTokenResponse = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token || !tokens.refresh_token || !tokens.expires_in) {
    throw new Error(tokens.errors ?? `Shopify token refresh failed (HTTP ${response.status})`);
  }
  return updateShopifyTokens({
    orgId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
  });
}

async function adminGet<T>(orgId: string, path: string): Promise<T> {
  const connection = await freshShopifyConnection(orgId);
  const response = await fetch(`https://${connection.shop_domain}/admin/api/${API_VERSION}/${path}`, {
    headers: { "X-Shopify-Access-Token": connection.access_token },
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.errors ? JSON.stringify(json.errors) : `Shopify API error (HTTP ${response.status})`);
  }
  return json as T;
}

export interface ShopifyProduct {
  id: number; title: string; status: string; vendor: string; productType: string;
  imageUrl: string | null; minPrice: string; maxPrice: string;
  variantCount: number; totalInventory: number;
}

export async function listShopifyProducts(orgId: string): Promise<ShopifyProduct[]> {
  const data = await adminGet<{ products: any[] }>(
    orgId,
    "products.json?limit=25&fields=id,title,status,vendor,product_type,image,variants",
  );
  return (data.products ?? []).map((p) => {
    const prices = (p.variants ?? []).map((v: any) => Number(v.price ?? 0));
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      vendor: p.vendor || "",
      productType: p.product_type || "",
      imageUrl: p.image?.src ?? null,
      minPrice: prices.length ? Math.min(...prices).toFixed(2) : "0.00",
      maxPrice: prices.length ? Math.max(...prices).toFixed(2) : "0.00",
      variantCount: (p.variants ?? []).length,
      totalInventory: (p.variants ?? []).reduce((sum: number, v: any) => sum + (v.inventory_quantity ?? 0), 0),
    };
  });
}

export interface ShopifyInventoryLevel {
  locationId: number; locationName: string; inventoryItemId: number; available: number | null;
}

export async function listShopifyInventory(orgId: string): Promise<ShopifyInventoryLevel[]> {
  const locations = await adminGet<{ locations: any[] }>(orgId, "locations.json?limit=10");
  const levels: ShopifyInventoryLevel[] = [];
  for (const location of locations.locations ?? []) {
    const data = await adminGet<{ inventory_levels: any[] }>(
      orgId,
      `inventory_levels.json?location_ids=${location.id}&limit=25`,
    );
    for (const level of data.inventory_levels ?? []) {
      levels.push({
        locationId: location.id,
        locationName: location.name,
        inventoryItemId: level.inventory_item_id,
        available: level.available ?? null,
      });
    }
  }
  return levels;
}

export interface ShopifyOrder {
  id: number; name: string; createdAt: string; financialStatus: string;
  fulfillmentStatus: string; totalPrice: string; customerName: string;
}

export async function listShopifyOrders(orgId: string): Promise<ShopifyOrder[]> {
  const data = await adminGet<{ orders: any[] }>(
    orgId,
    "orders.json?status=any&limit=25&fields=id,name,created_at,financial_status,fulfillment_status,total_price,customer",
  );
  return (data.orders ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    createdAt: o.created_at,
    financialStatus: o.financial_status || "",
    fulfillmentStatus: o.fulfillment_status || "unfulfilled",
    totalPrice: o.total_price || "0.00",
    customerName: o.customer ? `${o.customer.first_name ?? ""} ${o.customer.last_name ?? ""}`.trim() : "",
  }));
}

export interface ShopifyCustomer {
  id: number; name: string; email: string; ordersCount: number; totalSpent: string;
}

export async function listShopifyCustomers(orgId: string): Promise<ShopifyCustomer[]> {
  const data = await adminGet<{ customers: any[] }>(
    orgId,
    "customers.json?limit=25&fields=id,first_name,last_name,email,orders_count,total_spent",
  );
  return (data.customers ?? []).map((c) => ({
    id: c.id,
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(no name)",
    email: c.email || "",
    ordersCount: c.orders_count ?? 0,
    totalSpent: c.total_spent || "0.00",
  }));
}

export interface ShopifyContentItem {
  id: number; kind: "page" | "blog"; title: string; handle: string; publishedAt: string | null;
}

export async function listShopifyContent(orgId: string): Promise<ShopifyContentItem[]> {
  const [pages, blogs] = await Promise.all([
    adminGet<{ pages: any[] }>(orgId, "pages.json?limit=25&fields=id,title,handle,published_at"),
    adminGet<{ blogs: any[] }>(orgId, "blogs.json?limit=25&fields=id,title,handle,updated_at"),
  ]);
  const pageItems: ShopifyContentItem[] = (pages.pages ?? []).map((p) => ({
    id: p.id, kind: "page", title: p.title, handle: p.handle, publishedAt: p.published_at ?? null,
  }));
  const blogItems: ShopifyContentItem[] = (blogs.blogs ?? []).map((b) => ({
    id: b.id, kind: "blog", title: b.title, handle: b.handle, publishedAt: b.updated_at ?? null,
  }));
  return [...pageItems, ...blogItems];
}

/** Shopify's policy body is merchant-authored HTML; strip it to plain text so
 *  the console can show it directly without injecting HTML from the store. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ShopifyPolicy {
  title: string; url: string; body: string; updatedAt: string | null;
}

export async function listShopifyPolicies(orgId: string): Promise<ShopifyPolicy[]> {
  const data = await adminGet<{ policies: any[] }>(orgId, "policies.json");
  return (data.policies ?? []).map((p) => ({
    title: p.title,
    url: p.url || "",
    body: htmlToPlainText(p.body || ""),
    updatedAt: p.updated_at ?? null,
  }));
}
